// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20WrapperUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20WrapperUpgradeable.sol";
import {ERC20PermitUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {ERC20VotesUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import {NoncesUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Voting power for a token that has none
/// @notice Deposit any ERC-20 one-for-one and get a token that votes; withdraw it back at any time.
/// This is how a DAO is opened for a token that was not launched here -- a bridged asset, an old
/// token -- without asking its issuer for anything.
contract VotesWrapper is ERC20WrapperUpgradeable, ERC20PermitUpgradeable, ERC20VotesUpgradeable {
    constructor() {
        _disableInitializers();
    }

    function initialize(IERC20 underlying_, string calldata name_, string calldata symbol_) external initializer {
        __ERC20_init(name_, symbol_);
        __ERC20Wrapper_init(underlying_);
        __ERC20Permit_init(name_);
        __ERC20Votes_init();
    }

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function decimals() public view override(ERC20Upgradeable, ERC20WrapperUpgradeable) returns (uint8) {
        return super.decimals();
    }

    function _update(address from, address to, uint256 value) internal override(ERC20Upgradeable, ERC20VotesUpgradeable) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20PermitUpgradeable, NoncesUpgradeable) returns (uint256) {
        return super.nonces(owner);
    }
}
