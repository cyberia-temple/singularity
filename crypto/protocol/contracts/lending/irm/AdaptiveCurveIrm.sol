// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {IIrm} from "../interfaces/IIrm.sol";
import {Id, MarketParams, Market} from "../interfaces/ILending.sol";
import {MarketParamsLib} from "../MarketParamsLib.sol";
import {MathLib, WAD} from "../../libraries/MathLib.sol";
import {ExpLib, WAD_INT} from "../../libraries/ExpLib.sol";

/// @title An interest rate that finds its own level
/// @notice Markets here are opened by anyone, for tokens nobody has priced yet, so no person can be
/// asked to tune a rate curve for each of them. This model tunes itself. It aims for 90% of every
/// market's supply to be lent out:
///
///  - **Right now** the rate follows a curve around a target rate -- a quarter of it when nothing is
///    borrowed, four times it when everything is -- so a sudden rush of borrowing is priced at once.
///  - **Over time** the target rate itself drifts: up while utilization stays above 90%, down while
///    it stays below, at most doubling (or halving) in about five days of being fully used (or idle).
///
/// A market nobody wants to borrow from therefore ends up nearly free to borrow from, and one that
/// everybody wants to borrow from keeps getting more expensive until suppliers arrive or borrowers
/// leave. Rates are per second, in WAD; the target rate stays between 0.1% and 200% a year.
///
/// @dev Morpho's AdaptiveCurveIrm, re-derived. The drift is exponential in time, so the rate charged
/// over an interval is the average of the target at its start, middle and end, weighted 1:2:1.
contract AdaptiveCurveIrm is IIrm {
    using MathLib for uint256;
    using ExpLib for int256;
    using MarketParamsLib for MarketParams;

    int256 public constant CURVE_STEEPNESS = 4 ether;
    int256 public constant ADJUSTMENT_SPEED = 50 ether / int256(365 days);
    int256 public constant TARGET_UTILIZATION = 0.9 ether;
    int256 public constant INITIAL_RATE_AT_TARGET = 0.04 ether / int256(365 days);
    int256 public constant MIN_RATE_AT_TARGET = 0.001 ether / int256(365 days);
    int256 public constant MAX_RATE_AT_TARGET = 2.0 ether / int256(365 days);

    /// @notice The lending book allowed to move this model's state
    address public immutable LENDING;

    /// @notice Each market's current target rate, per second; zero until the market is created
    mapping(Id => int256) public rateAtTarget;

    event BorrowRateUpdate(Id indexed id, uint256 avgBorrowRate, uint256 rateAtTarget);

    error NotLending();
    error ZeroAddress();

    constructor(address lending) {
        if (lending == address(0)) revert ZeroAddress();
        LENDING = lending;
    }

    function borrowRateView(MarketParams memory marketParams, Market memory market) external view returns (uint256) {
        (uint256 avgRate,) = _borrowRate(marketParams.id(), market);
        return avgRate;
    }

    function borrowRate(MarketParams memory marketParams, Market memory market) external returns (uint256) {
        if (msg.sender != LENDING) revert NotLending();

        Id id = marketParams.id();
        (uint256 avgRate, int256 endRateAtTarget) = _borrowRate(id, market);

        rateAtTarget[id] = endRateAtTarget;

        emit BorrowRateUpdate(id, avgRate, uint256(endRateAtTarget));

        return avgRate;
    }

    function _borrowRate(Id id, Market memory market) private view returns (uint256, int256) {
        int256 utilization = int256(
            market.totalSupplyAssets > 0 ? uint256(market.totalBorrowAssets).wDivDown(market.totalSupplyAssets) : 0
        );

        // How far from target, normalized to [-1, 1] on each side of it.
        int256 errNormFactor = utilization > TARGET_UTILIZATION ? WAD_INT - TARGET_UTILIZATION : TARGET_UTILIZATION;
        int256 err = (utilization - TARGET_UTILIZATION).wDivToZero(errNormFactor);

        int256 startRateAtTarget = rateAtTarget[id];

        int256 avgRateAtTarget;
        int256 endRateAtTarget;

        if (startRateAtTarget == 0) {
            // First call for this market: the book is creating it.
            avgRateAtTarget = INITIAL_RATE_AT_TARGET;
            endRateAtTarget = INITIAL_RATE_AT_TARGET;
        } else {
            int256 speed = ADJUSTMENT_SPEED.wMulToZero(err);
            int256 elapsed = int256(block.timestamp - market.lastUpdate);
            int256 linearAdaptation = speed * elapsed;

            if (linearAdaptation == 0) {
                avgRateAtTarget = startRateAtTarget;
                endRateAtTarget = startRateAtTarget;
            } else {
                endRateAtTarget = _newRateAtTarget(startRateAtTarget, linearAdaptation);
                int256 midRateAtTarget = _newRateAtTarget(startRateAtTarget, linearAdaptation / 2);
                avgRateAtTarget = (startRateAtTarget + endRateAtTarget + 2 * midRateAtTarget) / 4;
            }
        }

        return (uint256(_curve(avgRateAtTarget, err)), endRateAtTarget);
    }

    /// @dev Below target the rate falls linearly to rateAtTarget / steepness at zero utilization;
    /// above it, it rises linearly to rateAtTarget · steepness at full utilization.
    function _curve(int256 _rateAtTarget, int256 err) private pure returns (int256) {
        int256 coeff = err < 0 ? WAD_INT - WAD_INT.wDivToZero(CURVE_STEEPNESS) : CURVE_STEEPNESS - WAD_INT;
        return (coeff.wMulToZero(err) + WAD_INT).wMulToZero(_rateAtTarget);
    }

    function _newRateAtTarget(int256 startRateAtTarget, int256 linearAdaptation) private pure returns (int256) {
        return startRateAtTarget.wMulToZero(linearAdaptation.wExp()).bound(MIN_RATE_AT_TARGET, MAX_RATE_AT_TARGET);
    }
}
