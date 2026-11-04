// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title The builders' fund: the fire pays the people who write the code
/// @notice Cyberia's thesis is that open-source work should be paid. A fixed share of every week's
/// ASH lands here -- and anyone else may add to it -- and is paid out in rounds to contributors:
/// merged work on the Singularity repository and on the repositories behind launched projects.
///
/// A round is a Merkle root over (contributor, amount) published with a link to the list it was
/// built from, so every payout can be traced to the contribution it pays for. A round can only
/// allocate ASH the fund actually holds and has not promised to an earlier round.
contract BuildersFund is AccessManaged {
    using SafeERC20 for IERC20;

    IERC20 public immutable ash;

    struct Round {
        bytes32 root;
        uint256 total;
        uint256 claimed;
        string uri;
    }

    Round[] internal _rounds;
    mapping(uint256 round => mapping(address => bool)) public claimed;

    /// @notice ASH promised to published rounds and not yet claimed
    uint256 public committed;

    event RoundPublished(uint256 indexed round, bytes32 root, uint256 total, string uri);
    event Claimed(uint256 indexed round, address indexed account, uint256 amount);

    error OverCommitted(uint256 available);
    error AlreadyClaimed();
    error BadProof();

    constructor(address authority, IERC20 ash_) AccessManaged(authority) {
        ash = ash_;
    }

    /// @notice ASH the next round may allocate
    function available() public view returns (uint256) {
        return ash.balanceOf(address(this)) - committed;
    }

    function publishRound(bytes32 root, uint256 total, string calldata uri) external restricted returns (uint256 round) {
        if (total > available()) revert OverCommitted(available());
        committed += total;
        round = _rounds.length;
        _rounds.push(Round(root, total, 0, uri));
        emit RoundPublished(round, root, total, uri);
    }

    /// @notice Pay `account` its part of a round; anyone may submit the proof on its behalf
    function claim(uint256 round, address account, uint256 amount, bytes32[] calldata proof) external {
        if (claimed[round][account]) revert AlreadyClaimed();
        Round storage r = _rounds[round];
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        if (!MerkleProof.verifyCalldata(proof, r.root, leaf)) revert BadProof();

        claimed[round][account] = true;
        r.claimed += amount;
        committed -= amount;
        ash.safeTransfer(account, amount);
        emit Claimed(round, account, amount);
    }

    function getRound(uint256 index) external view returns (Round memory) {
        return _rounds[index];
    }

    function roundsLength() external view returns (uint256) {
        return _rounds.length;
    }
}
