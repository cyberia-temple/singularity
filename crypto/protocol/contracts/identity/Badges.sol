// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @title Achievements that stay with the address that earned them
/// @notice First swap, first bridge, first launch, a season of farming: the backend notices and the
/// operator awards a badge. A badge is an ERC-1155 token so every wallet and explorer can show it,
/// and it cannot be transferred -- it says what this address did, not what it bought.
/// @dev Ids are plain numbers; what each one means and looks like lives off-chain, at `uri`, so a new
/// badge needs no contract change. Awards are idempotent: one of each id per address, at most.
contract Badges is ERC1155, AccessManaged {
    mapping(address account => mapping(uint256 id => uint64)) public awardedAt;

    event Awarded(address indexed account, uint256 indexed id);

    error Soulbound();
    error LengthMismatch();

    constructor(address authority, string memory uri_) ERC1155(uri_) AccessManaged(authority) {}

    function award(address account, uint256 id) public restricted {
        if (awardedAt[account][id] != 0) return;
        awardedAt[account][id] = uint64(block.timestamp);
        _mint(account, id, 1, "");
        emit Awarded(account, id);
    }

    function awardBatch(address[] calldata accounts, uint256[] calldata ids) external restricted {
        if (accounts.length != ids.length) revert LengthMismatch();
        for (uint256 i = 0; i < accounts.length; i++) {
            if (awardedAt[accounts[i]][ids[i]] != 0) continue;
            awardedAt[accounts[i]][ids[i]] = uint64(block.timestamp);
            _mint(accounts[i], ids[i], 1, "");
            emit Awarded(accounts[i], ids[i]);
        }
    }

    function setURI(string calldata uri_) external restricted {
        _setURI(uri_);
    }

    /// @dev Minting is the only movement a badge ever makes.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0)) revert Soulbound();
        super._update(from, to, ids, values);
    }
}
