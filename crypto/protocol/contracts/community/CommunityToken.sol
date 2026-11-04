// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {ERC20VotesUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import {NoncesUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";

/// @title A community's own token: minted as rewards, voted with in its DAO
/// @notice What a Telegram chat's `/create_token` makes: a token its owner -- the bot's airdrop key,
/// or a person -- mints to members as they earn it. Unlike a launched token, its supply grows; the
/// owner may fix a ceiling at creation (`maxSupply`, zero for none) and can give up minting for good.
/// It votes on a timestamp clock, so `DAOFactory.createDAO` works for it directly.
contract CommunityToken is ERC20PermitUpgradeable, ERC20VotesUpgradeable {
    address public owner;
    uint256 public maxSupply;

    event OwnerChanged(address indexed from, address indexed to);

    error NotOwner();
    error CapExceeded();

    constructor() {
        _disableInitializers();
    }

    function initialize(string calldata name_, string calldata symbol_, address owner_, uint256 maxSupply_)
        external
        initializer
    {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __ERC20Votes_init();
        owner = owner_;
        maxSupply = maxSupply_;
        emit OwnerChanged(address(0), owner_);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (maxSupply != 0 && totalSupply() + amount > maxSupply) revert CapExceeded();
        _mint(to, amount);
    }

    /// @notice Hand minting to someone else, or to nobody (`address(0)`) to fix the supply for good
    function setOwner(address owner_) external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnerChanged(owner, owner_);
        owner = owner_;
    }

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function _update(address from, address to, uint256 value) internal override(ERC20Upgradeable, ERC20VotesUpgradeable) {
        super._update(from, to, value);
    }

    function nonces(address owner_) public view override(ERC20PermitUpgradeable, NoncesUpgradeable) returns (uint256) {
        return super.nonces(owner_);
    }
}
