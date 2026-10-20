// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IOracle} from "../lending/interfaces/IOracle.sol";
import {IV3Pool} from "../interfaces/IV3.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// @title A lending price read from a V3 pool's own time-weighted history
/// @notice Prices one token of a V3 pool in the other, averaged over up to `window` seconds of the
/// pool's history -- never its spot price, which one swap can set to anything.
///
/// It refuses to answer at all until the pool has `minWindow` seconds of history. A token launched a
/// minute ago has no price worth lending against, and an oracle that reverts is the honest answer:
/// the lending book never asks for a price while nobody owes anything, so the only effect is that
/// nobody can *borrow* against the token until its market has existed for a while.
///
/// @dev What it costs to move this price is what it costs to hold a pool away from the market for
/// the whole window. Launch pools make that expensive twice over: their liquidity is locked forever
/// at full range and cannot be pulled to thin the book, and their fee is several percent each way.
/// It is still a price from one pool, so markets using it should carry a conservative LLTV and the
/// vaults that lend into them should cap what they lend.
contract V3TwapOracle is IOracle {
    uint256 internal constant PRICE_SCALE = 1e36;

    IV3Pool public immutable pool;

    /// @notice The token being priced (a lending market's collateral)
    address public immutable baseToken;

    /// @notice The token the price is quoted in (a lending market's loan token)
    address public immutable quoteToken;

    /// @notice The longest history the average is taken over
    uint32 public immutable window;

    /// @notice The least history the oracle will answer with
    uint32 public immutable minWindow;

    bool internal immutable baseIsToken0;

    error ZeroAddress();
    error BadWindow();
    error NotInPool();
    error PoolNotInitialized();
    error HistoryTooShort(uint32 available, uint32 required);

    constructor(IV3Pool pool_, address baseToken_, uint32 window_, uint32 minWindow_) {
        if (address(pool_) == address(0) || baseToken_ == address(0)) revert ZeroAddress();
        if (minWindow_ == 0 || minWindow_ > window_) revert BadWindow();

        address token0 = pool_.token0();
        address token1 = pool_.token1();
        if (baseToken_ != token0 && baseToken_ != token1) revert NotInPool();

        pool = pool_;
        baseToken = baseToken_;
        quoteToken = baseToken_ == token0 ? token1 : token0;
        baseIsToken0 = baseToken_ == token0;
        window = window_;
        minWindow = minWindow_;
    }

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        return priceAtTick(meanTick());
    }

    /// @notice The arithmetic-mean tick over the history the oracle is willing to use
    function meanTick() public view returns (int24 tick) {
        uint32 available = oldestObservationSecondsAgo();
        if (available < minWindow) revert HistoryTooShort(available, minWindow);
        uint32 secondsAgo = available < window ? available : window;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 period = int56(uint56(secondsAgo));

        tick = int24(delta / period);
        // Round toward negative infinity, as the pool's own tick does.
        if (delta < 0 && delta % period != 0) tick--;
    }

    /// @notice How far back the pool's recorded history reaches
    /// @dev The oldest observation sits in the slot after the newest one once the ring buffer has
    /// wrapped, and in slot 0 until it has.
    function oldestObservationSecondsAgo() public view returns (uint32) {
        (,, uint16 observationIndex, uint16 observationCardinality,,,) = pool.slot0();
        if (observationCardinality == 0) revert PoolNotInitialized();

        (uint32 observationTimestamp,,, bool initialized) =
            pool.observations((observationIndex + 1) % observationCardinality);
        if (!initialized) (observationTimestamp,,,) = pool.observations(0);

        unchecked {
            // uint32 timestamps wrap in 2106; the subtraction wraps with them.
            return uint32(block.timestamp) - observationTimestamp;
        }
    }

    /// @notice Quote units per base unit at `tick`, scaled by 1e36
    function priceAtTick(int24 tick) public view returns (uint256) {
        uint256 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);
        // token1 per token0 in Q128.128; sqrtPrice² fits because sqrtPrice < 2^160.
        uint256 priceX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);

        if (baseIsToken0) return Math.mulDiv(priceX128, PRICE_SCALE, 1 << 128);
        return Math.mulDiv(1 << 128, PRICE_SCALE, priceX128);
    }
}
