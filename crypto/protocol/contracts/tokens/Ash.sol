// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title ASH -- what Cyberia pays liquidity in
/// @notice ASH is emitted weekly by the `Minter`, falling every week, and never past `cap()`: the
/// most that will ever exist is written into the contract. Lock it in the `VotingEscrow` and you
/// decide which pools the next week's emission goes to -- and collect the incentives projects pay
/// for those votes and the protocol fees of the pools you vote for.
/// @dev The minter is set once and can never change, so the cap and the schedule the minter
/// enforces are the whole monetary policy. Votes use time as their clock (ERC-6372).
contract Ash is ERC20, ERC20Capped, ERC20Permit, ERC20Votes, AccessManaged {
    /// @notice The only address that can mint, once set
    address public minter;

    event MinterSet(address indexed minter);

    error NotMinter();
    error MinterAlreadySet();
    error ZeroAddress();

    /// @param initialHolder Receives `initialSupply`, if any: the genesis allocation
    constructor(address authority, uint256 cap_, address initialHolder, uint256 initialSupply)
        ERC20("Ash", "ASH")
        ERC20Capped(cap_)
        ERC20Permit("Ash")
        AccessManaged(authority)
    {
        if (initialSupply > 0) {
            if (initialHolder == address(0)) revert ZeroAddress();
            _mint(initialHolder, initialSupply);
        }
    }

    function setMinter(address minter_) external restricted {
        if (minter != address(0)) revert MinterAlreadySet();
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
        emit MinterSet(minter_);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Capped, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
