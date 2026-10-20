// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IV3Pool} from "../interfaces/IV3.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {LiquidityAmounts} from "../libraries/LiquidityAmounts.sol";

/// @title Full-range liquidity in a V3 pool, as a token
/// @notice A V3 position is an NFT with a price range, which is the right tool for a market maker and
/// the wrong one for everything else on this chain: it cannot be staked in a farm, posted as
/// collateral, or held by a vault, because none of those can tell one NFT from another. This vault
/// puts everyone's liquidity into one full-range position and hands out an ERC-20 share of it.
///
/// Shares are fungible, so they farm ASH in a gauge, secure loans in the lending book and sit in any
/// wallet. Trading fees are folded back into the position (`compound`, run by every deposit and
/// withdrawal and by anyone at any time), so a share is worth more liquidity over time and the fees
/// follow it wherever it goes -- into a farm or a loan included.
///
/// @dev Accounting is proportional, G-UNI style: a deposit buys shares with the same mix of the two
/// tokens the vault already holds (its position at the current price, plus whatever is idle), and a
/// withdrawal takes that same mix out. Moving the price before a deposit therefore changes what the
/// mix *is* but not what a share is worth in it. Rounding always favours the shares already issued.
/// The first deposit locks `MINIMUM_SHARES` to the burn address so the share price cannot be set by
/// a dust deposit followed by a donation.
contract LiquidityVault is ERC20Upgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant MINIMUM_SHARES = 1000;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @notice The factory that clones and initializes vaults
    address public immutable factory;

    IV3Pool public pool;
    IERC20 public token0;
    IERC20 public token1;
    int24 public tickLower;
    int24 public tickUpper;

    event Deposit(address indexed caller, address indexed receiver, uint256 shares, uint256 amount0, uint256 amount1);
    event Withdraw(address indexed caller, address indexed receiver, uint256 shares, uint256 amount0, uint256 amount1);
    event Compound(uint256 fees0, uint256 fees1, uint128 liquidityAdded);

    error NotFactory();
    error NotPool();
    error ZeroShares();
    error Slippage();
    error ZeroAddress();

    constructor() {
        factory = msg.sender;
        _disableInitializers();
    }

    function initialize(IV3Pool pool_, string calldata name_, string calldata symbol_) external initializer {
        if (msg.sender != factory) revert NotFactory();
        __ERC20_init(name_, symbol_);

        pool = pool_;
        token0 = IERC20(pool_.token0());
        token1 = IERC20(pool_.token1());

        int24 spacing = pool_.tickSpacing();
        // Division truncates towards zero, so both ends land inside the valid range.
        tickLower = (TickMath.MIN_TICK / spacing) * spacing;
        tickUpper = (TickMath.MAX_TICK / spacing) * spacing;
    }

    // ------------------------------------------------------------------------------------ views

    /// @notice What the vault holds right now: its position at the current price plus idle tokens.
    /// Fees not yet compounded are not included.
    function underlying() public view returns (uint256 amount0, uint256 amount1) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96, _sqrtLower(), _sqrtUpper(), positionLiquidity()
        );
        amount0 += token0.balanceOf(address(this));
        amount1 += token1.balanceOf(address(this));
    }

    function positionLiquidity() public view returns (uint128 liquidity) {
        (liquidity,,,,) = pool.positions(_positionKey());
    }

    // --------------------------------------------------------------------------------- actions

    /// @notice Add liquidity, paying in the vault's own mix of the two tokens
    /// @param amount0Max The most token0 to spend
    /// @param amount1Max The most token1 to spend
    /// @param minShares Revert unless at least this many shares are minted
    function deposit(uint256 amount0Max, uint256 amount1Max, uint256 minShares, address receiver)
        external
        nonReentrant
        returns (uint256 shares, uint256 amount0, uint256 amount1)
    {
        if (receiver == address(0)) revert ZeroAddress();
        _compound();

        uint256 supply = totalSupply();
        (shares, amount0, amount1) =
            supply == 0 ? _depositFirst(amount0Max, amount1Max) : _depositProportional(amount0Max, amount1Max, supply);

        if (amount0 > amount0Max || amount1 > amount1Max || shares < minShares) revert Slippage();

        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, shares, amount0, amount1);
    }

    /// @notice Burn shares for their part of the position and of the idle tokens
    function withdraw(uint256 shares, uint256 amount0Min, uint256 amount1Min, address receiver)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        _compound();

        uint256 supply = totalSupply();
        uint128 liquidityToRemove = Math.mulDiv(positionLiquidity(), shares, supply).toUint128();
        uint256 idleOut0 = Math.mulDiv(token0.balanceOf(address(this)), shares, supply);
        uint256 idleOut1 = Math.mulDiv(token1.balanceOf(address(this)), shares, supply);

        _burn(msg.sender, shares);

        if (liquidityToRemove > 0) {
            (uint256 burned0, uint256 burned1) = pool.burn(tickLower, tickUpper, liquidityToRemove);
            pool.collect(receiver, tickLower, tickUpper, burned0.toUint128(), burned1.toUint128());
            amount0 = burned0;
            amount1 = burned1;
        }

        if (idleOut0 > 0) token0.safeTransfer(receiver, idleOut0);
        if (idleOut1 > 0) token1.safeTransfer(receiver, idleOut1);
        amount0 += idleOut0;
        amount1 += idleOut1;

        if (amount0 < amount0Min || amount1 < amount1Min) revert Slippage();

        emit Withdraw(msg.sender, receiver, shares, amount0, amount1);
    }

    /// @notice Collect the position's trading fees and fold them back into it
    function compound() external nonReentrant {
        _compound();
    }

    /// @dev Pays the pool for a mint: from the vault's own balance when it is compounding, from the
    /// depositor otherwise. Only the pool may call it, and the pool only calls back whoever minted.
    function pancakeV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        if (msg.sender != address(pool)) revert NotPool();
        address payer = abi.decode(data, (address));

        if (payer == address(this)) {
            if (amount0Owed > 0) token0.safeTransfer(msg.sender, amount0Owed);
            if (amount1Owed > 0) token1.safeTransfer(msg.sender, amount1Owed);
        } else {
            if (amount0Owed > 0) token0.safeTransferFrom(payer, msg.sender, amount0Owed);
            if (amount1Owed > 0) token1.safeTransferFrom(payer, msg.sender, amount1Owed);
        }
    }

    // ------------------------------------------------------------------------------- internals

    function _depositFirst(uint256 amount0Max, uint256 amount1Max)
        internal
        returns (uint256 shares, uint256 amount0, uint256 amount1)
    {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, _sqrtLower(), _sqrtUpper(), amount0Max, amount1Max);
        if (liquidity <= MINIMUM_SHARES) revert ZeroShares();

        (amount0, amount1) = _addLiquidity(liquidity, msg.sender);
        shares = uint256(liquidity) - MINIMUM_SHARES;
        _mint(BURN, MINIMUM_SHARES);
    }

    function _depositProportional(uint256 amount0Max, uint256 amount1Max, uint256 supply)
        internal
        returns (uint256 shares, uint256 amount0, uint256 amount1)
    {
        uint128 liquidity = positionLiquidity();
        uint256 idle0 = token0.balanceOf(address(this));
        uint256 idle1 = token1.balanceOf(address(this));

        shares = _sharesFor(amount0Max, amount1Max, supply, liquidity, idle0, idle1);
        if (shares == 0 || shares == type(uint256).max) revert ZeroShares();

        uint128 liquidityToAdd = Math.mulDiv(liquidity, shares, supply, Math.Rounding.Ceil).toUint128();
        if (liquidityToAdd > 0) (amount0, amount1) = _addLiquidity(liquidityToAdd, msg.sender);

        uint256 idleIn0 = Math.mulDiv(idle0, shares, supply, Math.Rounding.Ceil);
        uint256 idleIn1 = Math.mulDiv(idle1, shares, supply, Math.Rounding.Ceil);
        if (idleIn0 > 0) token0.safeTransferFrom(msg.sender, address(this), idleIn0);
        if (idleIn1 > 0) token1.safeTransferFrom(msg.sender, address(this), idleIn1);
        amount0 += idleIn0;
        amount1 += idleIn1;
    }

    /// @dev The most shares the two amounts buy at the vault's current mix.
    function _sharesFor(
        uint256 amount0Max,
        uint256 amount1Max,
        uint256 supply,
        uint128 liquidity,
        uint256 idle0,
        uint256 idle1
    ) internal view returns (uint256 shares) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        (uint256 position0, uint256 position1) =
            LiquidityAmounts.getAmountsForLiquidity(sqrtPriceX96, _sqrtLower(), _sqrtUpper(), liquidity);

        shares = type(uint256).max;
        if (position0 + idle0 > 0) shares = Math.min(shares, Math.mulDiv(amount0Max, supply, position0 + idle0));
        if (position1 + idle1 > 0) shares = Math.min(shares, Math.mulDiv(amount1Max, supply, position1 + idle1));
    }

    function _compound() internal {
        uint256 fees0;
        uint256 fees1;

        if (positionLiquidity() > 0) {
            // A zero burn makes the pool book the fees the position has earned so far.
            pool.burn(tickLower, tickUpper, 0);
            (fees0, fees1) = pool.collect(address(this), tickLower, tickUpper, type(uint128).max, type(uint128).max);
        }

        uint256 idle0 = token0.balanceOf(address(this));
        uint256 idle1 = token1.balanceOf(address(this));
        // The pool rounds what it takes up, twice; two wei of slack keeps a compound from asking
        // for a hair more than the vault holds.
        if (idle0 <= 2 || idle1 <= 2) {
            if (fees0 > 0 || fees1 > 0) emit Compound(fees0, fees1, 0);
            return;
        }

        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, _sqrtLower(), _sqrtUpper(), idle0 - 2, idle1 - 2);
        if (liquidity > 0) _addLiquidity(liquidity, address(this));

        if (fees0 > 0 || fees1 > 0 || liquidity > 0) emit Compound(fees0, fees1, liquidity);
    }

    function _addLiquidity(uint128 liquidity, address payer) internal returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = pool.mint(address(this), tickLower, tickUpper, liquidity, abi.encode(payer));
    }

    function _positionKey() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), tickLower, tickUpper));
    }

    function _sqrtLower() internal view returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tickLower);
    }

    function _sqrtUpper() internal view returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tickUpper);
    }
}
