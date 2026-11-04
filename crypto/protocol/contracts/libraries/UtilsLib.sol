// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

error MaxUint128Exceeded();

library UtilsLib {
    /// @dev True when exactly one of the two is zero: an amount is given either in assets or in
    /// shares, never both and never neither.
    function exactlyOneZero(uint256 x, uint256 y) internal pure returns (bool z) {
        assembly {
            z := xor(iszero(x), iszero(y))
        }
    }

    function min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }

    function toUint128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert MaxUint128Exceeded();
        return uint128(x);
    }

    /// @dev max(x − y, 0)
    function zeroFloorSub(uint256 x, uint256 y) internal pure returns (uint256) {
        return x > y ? x - y : 0;
    }
}
