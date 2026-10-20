// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IV3Factory, IV3PositionManager, IWETH9} from "../interfaces/IV3.sol";
import {ILending, MarketParams, Id} from "../lending/interfaces/ILending.sol";
import {MarketParamsLib} from "../lending/MarketParamsLib.sol";
import {SharesMath} from "../libraries/SharesMath.sol";
import {LiquidityVaultFactory} from "../liquidity/LiquidityVaultFactory.sol";
import {LaunchLocker} from "../launch/LaunchLocker.sol";
import {Voter} from "../incentives/Voter.sol";

/// @title Where every protocol fee arrives, and where it goes from there
/// @notice The protocol earns in four places: the protocol share of V3 pool fees, the protocol's 1%
/// of every launch pool, the fee on lending interest, and app fees (names, predictions, the NFT
/// market). All of it lands here, and leaves in two ways:
///
///  - **To the voters of the pool that earned it.** Fees a pool can be credited with -- its own
///    protocol fees, its launch's protocol share -- are split `votersBps` to the voters of that
///    pool's gauge for the week, as an incentive. Lockers who vote for a pool are paid by that pool.
///  - **To fixed recipients.** Everything else is split by weights governance sets: the treasury,
///    the gas station's tank (paid in the coin), and whatever else is added.
///
/// @dev Every harvest and every split is permissionless; nobody has to remember to run a step for
/// anyone to be paid. Recipients who cannot take the coin are owed it instead of blocking the rest.
contract RevenueRouter is AccessManaged, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;

    uint256 internal constant BPS = 10_000;

    IV3Factory public immutable dexFactory;
    IV3PositionManager public immutable positions;
    IWETH9 public immutable wcyber;
    ILending public immutable lending;
    LiquidityVaultFactory public immutable vaults;

    LaunchLocker public locker;
    Voter public voter;

    /// @notice The share of attributable fees paid to the voters of the pool that earned them
    uint256 public votersBps;

    struct Share {
        address recipient;
        uint16 weight;
    }

    Share[] internal _shares;

    mapping(address => uint256) public owedNative;
    uint256 public totalOwedNative;

    event PoolHarvested(address indexed pool, address indexed gauge, uint256 amount0, uint256 amount1);
    event LaunchHarvested(uint256 indexed positionId, address indexed gauge, uint256 amount0, uint256 amount1);
    event LendingHarvested(Id indexed id, uint256 assets);
    event VotersPaid(address indexed gauge, address indexed token, uint256 amount);
    event Distributed(address indexed token, uint256 total);
    event Paid(address indexed token, address indexed recipient, uint256 amount);
    event PayoutDeferred(address indexed recipient, uint256 amount);
    event SharesSet(Share[] shares);
    event SettingsChanged();

    error BadShares();
    error BadBps();
    error NothingToDistribute();
    error NothingOwed();
    error TransferFailed();
    error WrappedNativeIsSplitAsCoin();

    constructor(
        address authority,
        IV3Factory dexFactory_,
        IV3PositionManager positions_,
        IWETH9 wcyber_,
        ILending lending_,
        LiquidityVaultFactory vaults_,
        Share[] memory shares_
    ) AccessManaged(authority) {
        dexFactory = dexFactory_;
        positions = positions_;
        wcyber = wcyber_;
        lending = lending_;
        vaults = vaults_;
        _setShares(shares_);
    }

    receive() external payable {}

    // -------------------------------------------------------------------------------- harvest

    /// @notice Sweep a pool's protocol fees here and pay its voters their part
    function harvestPool(address pool) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        (uint128 a0, uint128 a1) = dexFactory.collectProtocol(pool, address(this), type(uint128).max, type(uint128).max);
        (amount0, amount1) = (a0, a1);
        address gauge = _gaugeOfPool(pool);
        _payVoters(gauge, _token0(pool), amount0);
        _payVoters(gauge, _token1(pool), amount1);
        emit PoolHarvested(pool, gauge, amount0, amount1);
    }

    /// @notice Collect a launch position's fees through the locker and pay the launch's voters their
    /// part of the protocol's share
    function harvestLaunch(uint256 positionId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        (,, address token0, address token1, uint24 fee,,,,,,,) = positions.positions(positionId);
        uint256 before0 = IERC20(token0).balanceOf(address(this));
        uint256 before1 = IERC20(token1).balanceOf(address(this));

        locker.collect(positionId);

        amount0 = IERC20(token0).balanceOf(address(this)) - before0;
        amount1 = IERC20(token1).balanceOf(address(this)) - before1;

        address gauge = _gaugeOfPool(dexFactory.getPool(token0, token1, fee));
        _payVoters(gauge, token0, amount0);
        _payVoters(gauge, token1, amount1);
        emit LaunchHarvested(positionId, gauge, amount0, amount1);
    }

    /// @notice Turn the fee shares the lending book minted here into the loan token
    /// @dev Takes what the market can pay right now; the rest waits for borrowers to repay.
    function harvestLending(MarketParams memory params) external nonReentrant returns (uint256 assets) {
        Id id = params.id();
        lending.accrueInterest(params);
        (uint256 feeShares,,) = lending.position(id, address(this));
        if (feeShares == 0) return 0;

        (uint128 supplyAssets, uint128 supplyShares, uint128 borrowAssets,,,) = lending.market(id);
        uint256 cash = supplyAssets - borrowAssets;
        uint256 value = SharesMath.toAssetsDown(feeShares, supplyAssets, supplyShares);
        if (value <= cash) {
            (assets,) = lending.withdraw(params, 0, feeShares, address(this), address(this));
        } else if (cash > 0) {
            (assets,) = lending.withdraw(params, cash, 0, address(this), address(this));
        }
        emit LendingHarvested(id, assets);
    }

    // ------------------------------------------------------------------------------ distribute

    /// @notice Split this contract's whole balance of `token` between the recipients
    /// @dev WCYBER is split as the coin, by `distributeNative`: the gas station runs on it.
    function distribute(address token) public nonReentrant returns (uint256 total) {
        if (token == address(wcyber)) revert WrappedNativeIsSplitAsCoin();
        total = IERC20(token).balanceOf(address(this));
        if (total == 0) revert NothingToDistribute();

        uint256 last = _shares.length - 1;
        uint256 paid;
        for (uint256 i = 0; i <= last; i++) {
            uint256 amount = i == last ? total - paid : total * _shares[i].weight / BPS;
            paid += amount;
            if (amount > 0) {
                IERC20(token).safeTransfer(_shares[i].recipient, amount);
                emit Paid(token, _shares[i].recipient, amount);
            }
        }
        emit Distributed(token, total);
    }

    /// @notice Unwrap the WCYBER held here and split it, with the native balance, as the coin
    function distributeNative() external nonReentrant returns (uint256 total) {
        uint256 wrapped = wcyber.balanceOf(address(this));
        if (wrapped > 0) wcyber.withdraw(wrapped);

        total = address(this).balance - totalOwedNative;
        if (total == 0) revert NothingToDistribute();

        uint256 last = _shares.length - 1;
        uint256 paid;
        for (uint256 i = 0; i <= last; i++) {
            uint256 amount = i == last ? total - paid : total * _shares[i].weight / BPS;
            paid += amount;
            _payNative(_shares[i].recipient, amount);
        }
        emit Distributed(address(0), total);
    }

    /// @notice Deliver native payouts that a recipient could not take when they were split
    function claimNative(address recipient) external nonReentrant {
        uint256 amount = owedNative[recipient];
        if (amount == 0) revert NothingOwed();
        owedNative[recipient] = 0;
        totalOwedNative -= amount;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Paid(address(0), recipient, amount);
    }

    function shares() external view returns (Share[] memory) {
        return _shares;
    }

    // ------------------------------------------------------------------------------ governance

    function setShares(Share[] calldata shares_) external restricted {
        _setShares(shares_);
    }

    function setVotersBps(uint256 bps) external restricted {
        if (bps > BPS) revert BadBps();
        votersBps = bps;
        emit SettingsChanged();
    }

    function setModules(LaunchLocker locker_, Voter voter_) external restricted {
        locker = locker_;
        voter = voter_;
        emit SettingsChanged();
    }

    // ------------------------------------------------------------------------------- internals

    function _gaugeOfPool(address pool) internal view returns (address gauge) {
        if (address(voter) == address(0) || pool == address(0)) return address(0);
        address vault = vaults.vaultOf(pool);
        if (vault == address(0)) return address(0);
        gauge = voter.gaugeOf(vault);
        if (gauge != address(0) && !voter.isAlive(gauge)) gauge = address(0);
    }

    function _payVoters(address gauge, address token, uint256 amount) internal {
        if (gauge == address(0) || amount == 0 || votersBps == 0) return;
        uint256 share = amount * votersBps / BPS;
        if (share == 0) return;
        IERC20(token).forceApprove(address(voter), share);
        voter.incentivize(gauge, token, share);
        emit VotersPaid(gauge, token, share);
    }

    function _payNative(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = recipient.call{value: amount, gas: 50_000}("");
        if (ok) {
            emit Paid(address(0), recipient, amount);
        } else {
            owedNative[recipient] += amount;
            totalOwedNative += amount;
            emit PayoutDeferred(recipient, amount);
        }
    }

    function _setShares(Share[] memory shares_) internal {
        uint256 n = shares_.length;
        if (n == 0) revert BadShares();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            if (shares_[i].recipient == address(0)) revert BadShares();
            sum += shares_[i].weight;
        }
        if (sum != BPS) revert BadShares();

        delete _shares;
        for (uint256 i = 0; i < n; i++) {
            _shares.push(shares_[i]);
        }
        emit SharesSet(shares_);
    }

    function _token0(address pool) internal view returns (address) {
        return IPoolTokens(pool).token0();
    }

    function _token1(address pool) internal view returns (address) {
        return IPoolTokens(pool).token1();
    }
}

interface IPoolTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}
