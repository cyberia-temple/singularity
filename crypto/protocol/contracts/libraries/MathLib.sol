// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

uint256 constant WAD = 1e18;

/// @title Fixed-point arithmetic in 18 decimals, rounding stated at every call site
/// @notice A lending book is a set of quantities that must round *against* whoever is asking: a
/// depositor's shares down, a borrower's debt up. Every helper here names its direction so that a
/// reader can check each call against that rule instead of trusting a default.
library MathLib {
    function wMulDown(uint256 x, uint256 y) internal pure returns (uint256) {
        return mulDivDown(x, y, WAD);
    }

    function wDivDown(uint256 x, uint256 y) internal pure returns (uint256) {
        return mulDivDown(x, WAD, y);
    }

    function wDivUp(uint256 x, uint256 y) internal pure returns (uint256) {
        return mulDivUp(x, WAD, y);
    }

    function mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y) / d;
    }

    function mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y + (d - 1)) / d;
    }

    /// @dev e^(x·n) − 1 by its first three Taylor terms. For the per-second rates and the gaps
    /// between interactions a market actually sees, the fourth term is below a wei of interest; it
    /// errs low, which is the side a borrower is owed.
    function wTaylorCompounded(uint256 x, uint256 n) internal pure returns (uint256) {
        uint256 firstTerm = x * n;
        uint256 secondTerm = mulDivDown(firstTerm, firstTerm, 2 * WAD);
        uint256 thirdTerm = mulDivDown(secondTerm, firstTerm, 3 * WAD);

        return firstTerm + secondTerm + thirdTerm;
    }
}
