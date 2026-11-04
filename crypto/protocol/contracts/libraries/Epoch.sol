// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// @title Weekly epochs
/// @notice The incentive system runs on weeks that start on Thursday 00:00 UTC -- the Unix epoch was
/// a Thursday, so a week is simply `timestamp / 1 weeks`. Votes are cast in one week and decide where
/// the next week's emission goes; incentives paid into a week go to that week's voters.
library Epoch {
    uint256 internal constant WEEK = 7 days;

    function current() internal view returns (uint256) {
        return block.timestamp / WEEK;
    }

    function start(uint256 epoch) internal pure returns (uint256) {
        return epoch * WEEK;
    }

    function next() internal view returns (uint256) {
        return start(current() + 1);
    }
}
