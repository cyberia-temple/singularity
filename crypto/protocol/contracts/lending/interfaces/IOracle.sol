// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// @notice Price of one raw unit of collateral, quoted in raw units of the loan token and scaled by
/// 1e36. Decimals are already inside the number: if one CYBER is two dollars, one wei of WCYBER is
/// 2e-12 raw units of six-decimal USDC, so a WCYBER/USDC oracle reads 2e24 (= 2e36 · 1e6 / 1e18).
interface IOracle {
    function price() external view returns (uint256);
}
