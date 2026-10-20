// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {Epoch} from "../libraries/Epoch.sol";

/// @title Locked ASH, which votes
/// @notice Lock ASH for up to two years and it votes on where emissions go. Voting power is the
/// amount scaled by how much of the two years is left, so it falls as the unlock approaches; a lock
/// made permanent keeps full power until its owner starts the two-year countdown again.
///
/// Locks end on an epoch boundary, so ASH can never vote twice in one week: it is still locked for
/// the whole week it voted in.
///
/// @dev One lock per address and nothing transferable. Voting power is read at the moment a vote is
/// cast; there is no history to checkpoint because a vote is a weight fixed for its own epoch.
contract VotingEscrow is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant MAXTIME = 2 * 365 days;

    IERC20 public immutable ash;

    struct Lock {
        uint128 amount;
        uint64 end;
        bool permanent;
    }

    mapping(address => Lock) public locks;
    uint256 public totalLocked;

    event Locked(address indexed owner, uint256 amount, uint256 end, bool permanent);
    event Withdrawn(address indexed owner, uint256 amount);

    error ZeroAmount();
    error LockExists();
    error NoLock();
    error LockExpired();
    error BadDuration();
    error StillLocked();
    error Permanent();
    error NotPermanent();

    constructor(IERC20 ash_) {
        ash = ash_;
    }

    // ---------------------------------------------------------------------------------- views

    /// @notice What `owner` votes with right now
    function votingPower(address owner) public view returns (uint256) {
        Lock memory lock = locks[owner];
        if (lock.permanent) return lock.amount;
        if (lock.end <= block.timestamp) return 0;
        return uint256(lock.amount) * (lock.end - block.timestamp) / MAXTIME;
    }

    // -------------------------------------------------------------------------------- actions

    function createLock(uint256 amount, uint256 duration) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (locks[msg.sender].amount != 0) revert LockExists();

        uint64 end = _end(duration);
        locks[msg.sender] = Lock(uint128(amount), end, false);
        _pull(amount);

        emit Locked(msg.sender, amount, end, false);
    }

    /// @notice Add ASH to a live lock -- yours or anyone's
    function increaseAmount(address owner, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Lock storage lock = locks[owner];
        if (lock.amount == 0) revert NoLock();
        if (!lock.permanent && lock.end <= block.timestamp) revert LockExpired();

        lock.amount += uint128(amount);
        _pull(amount);

        emit Locked(owner, lock.amount, lock.end, lock.permanent);
    }

    function increaseUnlockTime(uint256 duration) external {
        Lock storage lock = locks[msg.sender];
        if (lock.amount == 0) revert NoLock();
        if (lock.permanent) revert Permanent();
        if (lock.end <= block.timestamp) revert LockExpired();

        uint64 end = _end(duration);
        if (end <= lock.end) revert BadDuration();
        lock.end = end;

        emit Locked(msg.sender, lock.amount, end, false);
    }

    /// @notice Keep full voting power until you choose otherwise
    function lockPermanent() external {
        Lock storage lock = locks[msg.sender];
        if (lock.amount == 0) revert NoLock();
        if (lock.permanent) revert Permanent();
        if (lock.end <= block.timestamp) revert LockExpired();

        lock.permanent = true;
        lock.end = 0;

        emit Locked(msg.sender, lock.amount, 0, true);
    }

    /// @notice Start the two-year countdown again
    function unlockPermanent() external {
        Lock storage lock = locks[msg.sender];
        if (!lock.permanent) revert NotPermanent();

        lock.permanent = false;
        lock.end = _end(MAXTIME);

        emit Locked(msg.sender, lock.amount, lock.end, false);
    }

    function withdraw() external nonReentrant {
        Lock memory lock = locks[msg.sender];
        if (lock.amount == 0) revert NoLock();
        if (lock.permanent) revert Permanent();
        if (block.timestamp < lock.end) revert StillLocked();

        delete locks[msg.sender];
        totalLocked -= lock.amount;
        ash.safeTransfer(msg.sender, lock.amount);

        emit Withdrawn(msg.sender, lock.amount);
    }

    // ------------------------------------------------------------------------------ internals

    /// @dev Rounded down to an epoch boundary, so a lock always spans whole voting weeks.
    function _end(uint256 duration) internal view returns (uint64) {
        if (duration > MAXTIME) revert BadDuration();
        uint256 end = (block.timestamp + duration) / Epoch.WEEK * Epoch.WEEK;
        if (end <= block.timestamp) revert BadDuration();
        return uint64(end);
    }

    function _pull(uint256 amount) internal {
        totalLocked += amount;
        ash.safeTransferFrom(msg.sender, address(this), amount);
    }
}
