// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {MathLib} from "./MathLib.sol";

/// @title Conversion between assets and shares with a virtual offset
/// @notice The offset is what makes an empty market safe to open. Without it the first depositor
/// can mint one share, donate the asset and set the exchange rate so high that the next deposit
/// rounds to zero shares -- the inflation attack the old Compound-style Cyberia markets were open
/// to, and that has drained several real Compound forks. With a million virtual
/// shares backed by one virtual wei, moving the rate by a factor k costs the attacker k·10⁶ wei
/// for every wei they could steal.
library SharesMath {
    using MathLib for uint256;

    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    function toSharesDown(uint256 assets, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return assets.mulDivDown(totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function toAssetsDown(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return shares.mulDivDown(totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    function toSharesUp(uint256 assets, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return assets.mulDivUp(totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return shares.mulDivUp(totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }
}
