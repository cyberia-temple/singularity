// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {VotingEscrow} from "./VotingEscrow.sol";

/// @title ASH for the people who crossed first, arriving already locked
/// @notice There is no team allocation of ASH. The only ASH that exists before the fire is this
/// drop: a fixed share of the cap for the community that brings CYBER.sol over from Solana in the
/// first weeks -- the holders who made the chain worth starting. It is not handed out liquid: each
/// claim becomes a year-long veASH lock, so the first voters on where emissions go are the people
/// who were here first, and none of it can be sold on day one.
///
/// The list is a Merkle root over (account, amount) built from the bridge's own release events,
/// published once. What nobody claims by `deadline` goes to the builders' fund.
contract PioneerDrop is AccessManaged {
    using SafeERC20 for IERC20;

    IERC20 public immutable ash;
    VotingEscrow public immutable ve;
    uint256 public immutable lockDuration;
    address public immutable leftoverTo;

    bytes32 public root;
    uint64 public deadline;
    mapping(address => bool) public claimed;

    event RootSet(bytes32 root, uint64 deadline);
    event Claimed(address indexed account, uint256 amount);
    event Swept(uint256 amount);

    error RootAlreadySet();
    error NoRoot();
    error Closed();
    error StillOpen();
    error AlreadyClaimed();
    error BadProof();

    constructor(address authority, IERC20 ash_, VotingEscrow ve_, uint256 lockDuration_, address leftoverTo_)
        AccessManaged(authority)
    {
        ash = ash_;
        ve = ve_;
        lockDuration = lockDuration_;
        leftoverTo = leftoverTo_;
    }

    function setRoot(bytes32 root_, uint64 deadline_) external restricted {
        if (root != bytes32(0)) revert RootAlreadySet();
        root = root_;
        deadline = deadline_;
        emit RootSet(root_, deadline_);
    }

    /// @notice Claim `account`'s share into a veASH lock; anyone may submit it for them
    /// @dev An account that already has a live lock gets the drop added to it. One with an expired,
    /// unwithdrawn lock must withdraw it first.
    function claim(address account, uint256 amount, bytes32[] calldata proof) external {
        if (root == bytes32(0)) revert NoRoot();
        if (block.timestamp > deadline) revert Closed();
        if (claimed[account]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert BadProof();
        claimed[account] = true;

        ash.forceApprove(address(ve), amount);
        (uint128 locked,,) = ve.locks(account);
        if (locked == 0) ve.createLockFor(account, amount, lockDuration);
        else ve.increaseAmount(account, amount);

        emit Claimed(account, amount);
    }

    /// @notice After the deadline, what nobody claimed goes to the builders
    function sweep() external {
        if (root == bytes32(0) || block.timestamp <= deadline) revert StillOpen();
        uint256 amount = ash.balanceOf(address(this));
        ash.safeTransfer(leftoverTo, amount);
        emit Swept(amount);
    }
}
