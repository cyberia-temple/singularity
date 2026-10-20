// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IOracle} from "../lending/interfaces/IOracle.sol";
import {LiquidityVault} from "../liquidity/LiquidityVault.sol";
import {LiquidityAmounts} from "../libraries/LiquidityAmounts.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {V3TwapOracle} from "./V3TwapOracle.sol";

/// @title What one LP vault share is worth, valued at the pool's average price
/// @notice Prices a `LiquidityVault` share in one of its pool's tokens, so the shares can secure a
/// loan -- borrow CYBER against your LP position and keep earning its fees.
///
/// @dev The obvious valuation -- the vault's holdings at the pool's current price -- is exactly
/// what a flash swap can move. This one recomputes what the vault's liquidity would hold *at the
/// time-weighted average price* and values that at the same price, so pushing the pool around
/// changes neither the amounts nor the price used. Fees not yet compounded are left out, which only
/// errs low. Like the TWAP it reads, it refuses to price a pool without enough history.
contract LiquidityVaultOracle is IOracle {
    uint256 internal constant PRICE_SCALE = 1e36;

    LiquidityVault public immutable vault;
    /// @notice The TWAP oracle of the vault's pool, read for its mean tick only
    V3TwapOracle public immutable twap;
    /// @notice The pool token prices are quoted in
    address public immutable quoteToken;

    bool internal immutable quoteIsToken1;

    error NotVaultPool();
    error NotInPool();

    constructor(LiquidityVault vault_, V3TwapOracle twap_, address quoteToken_) {
        if (address(twap_.pool()) != address(vault_.pool())) revert NotVaultPool();
        address token0 = address(vault_.token0());
        address token1 = address(vault_.token1());
        if (quoteToken_ != token0 && quoteToken_ != token1) revert NotInPool();

        vault = vault_;
        twap = twap_;
        quoteToken = quoteToken_;
        quoteIsToken1 = quoteToken_ == token1;
    }

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        uint256 supply = vault.totalSupply();
        if (supply == 0) return 0;
        return Math.mulDiv(valueAtTwap(), PRICE_SCALE, supply);
    }

    /// @notice The vault's holdings at the average price, in `quoteToken`
    function valueAtTwap() public view returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(twap.meanTick());
        (uint256 amount0, uint256 amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(vault.tickLower()),
            TickMath.getSqrtRatioAtTick(vault.tickUpper()),
            vault.positionLiquidity()
        );
        amount0 += vault.token0().balanceOf(address(vault));
        amount1 += vault.token1().balanceOf(address(vault));

        // token1 per token0 in Q128
        uint256 priceX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        if (quoteIsToken1) return amount1 + Math.mulDiv(amount0, priceX128, 1 << 128);
        return amount0 + Math.mulDiv(amount1, 1 << 128, priceX128);
    }
}
