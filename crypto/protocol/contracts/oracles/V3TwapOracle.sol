// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IOracle} from "../lending/interfaces/IOracle.sol";
import {IV3Pool} from "../interfaces/IV3.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// @title A lending price read from a V3 pool's time-weighted history
/// @notice Prices one token of a V3 pool in the other, averaged over `window` seconds of history --
/// never the spot price, which one swap can set to anything.
///
/// It refuses to answer until the pool has `minWindow` seconds of history. A token launched a minute
/// ago has no price worth lending against, and a revert is the honest answer: the lending book asks
/// for a price only when somebody owes something, so the only effect is that nobody can borrow
/// against the token until its market has existed for a while.
///
/// @dev **Two sources of history.** The pool's own observation ring is exact, and is used whenever
/// it reaches back a whole window. But the ring holds one observation per block that traded, and on
/// an Avalanche L1 a block exists whenever somebody sends a transaction: a few dozen dust swaps in a
/// row wrap a small ring in a minute. Reading less history then would hand a manipulator a short
/// window; refusing to read at all would let a borrower freeze their own liquidation. So the oracle
/// also keeps checkpoints of its own -- the pool's cumulative tick, at most one per `CHECKPOINT_PERIOD`
/// -- written by `poke`, which anyone may call and a keeper calls on schedule. Checkpoints cannot be
/// spammed, so whatever the ring holds, a full window stays available. If nobody pokes for a long
/// time the average simply covers more time: staler, never shorter.
///
/// What it costs to move this price is what it costs to hold the pool away from the market for the
/// whole window. Launch pools make that expensive twice over: their liquidity is locked at full
/// range forever, and their fee is several percent each way. It is still one pool's price, so
/// markets using it should carry a conservative LLTV and vaults should cap what they lend into them.
contract V3TwapOracle is IOracle {
    uint256 internal constant PRICE_SCALE = 1e36;

    /// @notice The least time between two checkpoints
    uint32 public constant CHECKPOINT_PERIOD = 5 minutes;

    /// @notice How many checkpoints are kept
    uint256 public constant CHECKPOINTS = 24;

    IV3Pool public immutable pool;

    /// @notice The token being priced (a lending market's collateral)
    address public immutable baseToken;

    /// @notice The token the price is quoted in (a lending market's loan token)
    address public immutable quoteToken;

    /// @notice The history the average is taken over
    uint32 public immutable window;

    /// @notice The least history the oracle will answer with
    uint32 public immutable minWindow;

    bool internal immutable baseIsToken0;

    struct Checkpoint {
        uint32 timestamp;
        int56 tickCumulative;
    }

    Checkpoint[CHECKPOINTS] public checkpoints;
    uint256 public checkpointCount;

    event Poked(uint32 timestamp, int56 tickCumulative);

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

        _checkpoint();
    }

    // ---------------------------------------------------------------------------------- price

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        return priceAtTick(meanTick());
    }

    /// @notice The average tick over `window` -- or, while there is not that much history yet, over
    /// all of it, provided that is at least `minWindow`
    function meanTick() public view returns (int24) {
        (uint32 ringAge, bool ringWrapped) = _ringHistory();

        // The ring covers the whole window: exact, and the usual case.
        if (ringAge >= window) return _meanTickFromRing(window);

        // A young pool whose ring has not wrapped: the ring *is* the pool's whole life.
        if (!ringWrapped && ringAge >= minWindow) return _meanTickFromRing(ringAge);

        // Otherwise the oracle's own checkpoints: the newest at least a window old, or failing that
        // the oldest, if it is at least minWindow old.
        (bool found, Checkpoint memory cp, uint32 age) = _checkpointFor();
        if (!found) revert HistoryTooShort(ringAge > age ? ringAge : age, minWindow);

        int56 delta = _cumulativeNow() - cp.tickCumulative;
        return _divFloor(delta, age);
    }

    /// @notice Quote units per base unit at `tick`, scaled by 1e36
    function priceAtTick(int24 tick) public view returns (uint256) {
        uint256 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);
        // token1 per token0 in Q128.128; sqrtPrice² fits because sqrtPrice < 2^160.
        uint256 priceX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);

        if (baseIsToken0) return Math.mulDiv(priceX128, PRICE_SCALE, 1 << 128);
        return Math.mulDiv(1 << 128, PRICE_SCALE, priceX128);
    }

    // ----------------------------------------------------------------------------- checkpoints

    /// @notice Record the pool's cumulative tick, if the last checkpoint is `CHECKPOINT_PERIOD` old
    function poke() external returns (bool written) {
        Checkpoint memory last = checkpoints[(checkpointCount - 1) % CHECKPOINTS];
        if (block.timestamp < uint256(last.timestamp) + CHECKPOINT_PERIOD) return false;
        _checkpoint();
        return true;
    }

    /// @notice How far back the pool's own observation ring reaches, and whether it has wrapped
    function ringHistory() external view returns (uint32 age, bool wrapped) {
        return _ringHistory();
    }

    // ------------------------------------------------------------------------------- internals

    function _checkpoint() internal {
        int56 cumulative = _cumulativeNow();
        checkpoints[checkpointCount % CHECKPOINTS] = Checkpoint(uint32(block.timestamp), cumulative);
        checkpointCount += 1;
        emit Poked(uint32(block.timestamp), cumulative);
    }

    /// @dev Newest first: the first checkpoint at least a window old wins; otherwise the oldest one
    /// kept, if it is at least minWindow old.
    function _checkpointFor() internal view returns (bool found, Checkpoint memory cp, uint32 age) {
        uint256 n = checkpointCount < CHECKPOINTS ? checkpointCount : CHECKPOINTS;
        for (uint256 k = 0; k < n; k++) {
            Checkpoint memory candidate = checkpoints[(checkpointCount - 1 - k) % CHECKPOINTS];
            uint32 candidateAge = uint32(block.timestamp) - candidate.timestamp;
            if (candidateAge >= window) return (true, candidate, candidateAge);
            if (k == n - 1 && candidateAge >= minWindow) return (true, candidate, candidateAge);
            age = candidateAge;
        }
    }

    function _ringHistory() internal view returns (uint32 age, bool wrapped) {
        (,, uint16 observationIndex, uint16 observationCardinality,,,) = pool.slot0();
        if (observationCardinality == 0) revert PoolNotInitialized();

        (uint32 observationTimestamp,,, bool initialized) =
            pool.observations((observationIndex + 1) % observationCardinality);
        wrapped = initialized;
        if (!initialized) (observationTimestamp,,,) = pool.observations(0);

        unchecked {
            // uint32 timestamps wrap in 2106; the subtraction wraps with them.
            age = uint32(block.timestamp) - observationTimestamp;
        }
    }

    function _meanTickFromRing(uint32 secondsAgo) internal view returns (int24) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);
        return _divFloor(tickCumulatives[1] - tickCumulatives[0], secondsAgo);
    }

    function _cumulativeNow() internal view returns (int56) {
        uint32[] memory secondsAgos = new uint32[](1);
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);
        return tickCumulatives[0];
    }

    /// @dev Rounds toward negative infinity, as the pool's own tick does.
    function _divFloor(int56 delta, uint32 period) internal pure returns (int24 tick) {
        int56 p = int56(uint56(period));
        tick = int24(delta / p);
        if (delta < 0 && delta % p != 0) tick--;
    }
}
