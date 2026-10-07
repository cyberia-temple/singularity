// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test doubles for CyberiaDomains: a token and the two shapes of launchpad listing.
contract MockZoneToken is ERC20 {
    constructor(string memory n, string memory s, uint256 supply, address to) ERC20(n, s) {
        _mint(to, supply);
    }
}

contract MockPairLaunchpad {
    mapping(address => address) public pairOf;

    function list(address token) external {
        pairOf[token] = address(0xBEEF);
    }
}

contract MockPoolLaunchpad {
    mapping(address => address) public poolOf;

    function list(address token) external {
        poolOf[token] = address(0xBEEF);
    }
}
