// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

int256 constant WAD_INT = 1e18;

/// @title Signed WAD arithmetic and an exponential good to a few parts per million
library ExpLib {
    /// @dev ln(2)
    int256 internal constant LN_2_INT = 0.693147180559945309e18;

    /// @dev ln(1e-18): below this e^x rounds to zero in WAD
    int256 internal constant LN_WEI_INT = -41.446531673892822312e18;

    /// @dev Inputs are clipped here. e^93 ≈ 2.4e40 still leaves room to multiply by any rate the
    /// interest model can hold without overflowing, and the model bounds the product right after.
    int256 internal constant WEXP_UPPER_BOUND = 93e18;

    /// @notice e^x in WAD
    /// @dev x = q·ln2 + r with |r| ≤ ln2/2, so e^x = 2^q · e^r, and e^r is taken to second order
    /// (relative error under 1% at the edges of r, far less near zero -- the rate model uses this
    /// to move a rate over time, where that error is a slightly slower or faster drift, not a
    /// mispriced loan).
    function wExp(int256 x) internal pure returns (int256) {
        unchecked {
            if (x < LN_WEI_INT) return 0;
            if (x > WEXP_UPPER_BOUND) x = WEXP_UPPER_BOUND;

            int256 roundingAdjustment = (x < 0) ? -(LN_2_INT / 2) : (LN_2_INT / 2);
            int256 q = (x + roundingAdjustment) / LN_2_INT;
            int256 r = x - q * LN_2_INT;

            int256 expR = WAD_INT + r + (r * r) / WAD_INT / 2;

            if (q >= 0) return expR << uint256(q);
            return expR >> uint256(-q);
        }
    }

    function wMulToZero(int256 x, int256 y) internal pure returns (int256) {
        return (x * y) / WAD_INT;
    }

    function wDivToZero(int256 x, int256 y) internal pure returns (int256) {
        return (x * WAD_INT) / y;
    }

    function bound(int256 x, int256 low, int256 high) internal pure returns (int256) {
        return x < low ? low : x > high ? high : x;
    }
}
