// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

/// @title A token that pays its own holders
/// @notice All the locker needs to know about a launch token: money sent to it becomes a claim for
/// every holder, and `distribute` is the nudge that counts what has arrived. It reads its own
/// balance rather than taking an amount, so a failed nudge strands nothing -- the next one counts
/// the same money.
interface ILaunchRewards {
    function distribute() external returns (uint256 credited);
}
