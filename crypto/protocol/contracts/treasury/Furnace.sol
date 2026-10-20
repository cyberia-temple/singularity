// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {IWETH9} from "../interfaces/IV3.sol";

/// @title The furnace: where CYBER goes to burn
/// @notice Send CYBER here -- or WCYBER through `burnWrapped` -- and it is gone for good, forwarded to
/// the same blackhole address the chain burns transaction fees into. One address therefore holds
/// every CYBER ever destroyed on Cyberia, whether it was gas, a protocol fee or a name, and anyone
/// can read the total from its balance.
///
/// Burning is what makes ASH: the `Minter` turns each week's burned CYBER into ASH, and the bridge
/// burns the matching CYBER.sol on Solana. The protocol's share of revenue, `.cyber` name fees and
/// anyone who wants to feed the fire burn here.
contract Furnace {
    /// @notice Where subnet-evm sends burned fees; nobody holds its key
    address public constant BLACKHOLE = 0x0100000000000000000000000000000000000000;

    IWETH9 public immutable wcyber;

    /// @notice CYBER burned through this contract (the chain's gas burns are counted by the blackhole)
    uint256 public totalBurned;

    event Burned(address indexed from, uint256 amount);

    error BurnFailed();

    constructor(IWETH9 wcyber_) {
        wcyber = wcyber_;
    }

    /// @notice Burn whatever CYBER arrives
    receive() external payable {
        if (msg.sender != address(wcyber)) _burn(msg.sender, msg.value);
    }

    function burn() external payable {
        _burn(msg.sender, msg.value);
    }

    /// @notice Burn WCYBER held by the caller (approve first)
    function burnWrapped(uint256 amount) external {
        wcyber.transferFrom(msg.sender, address(this), amount);
        wcyber.withdraw(amount);
        _burn(msg.sender, amount);
    }

    /// @notice Every CYBER destroyed on the chain so far: gas and furnace alike
    function burnedEverywhere() external view returns (uint256) {
        return BLACKHOLE.balance;
    }

    function _burn(address from, uint256 amount) internal {
        if (amount == 0) return;
        totalBurned += amount;
        (bool ok,) = BLACKHOLE.call{value: amount}("");
        if (!ok) revert BurnFailed();
        emit Burned(from, amount);
    }
}
