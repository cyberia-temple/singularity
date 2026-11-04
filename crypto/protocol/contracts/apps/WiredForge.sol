// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title WiredForge — the anti-cheat backbone of the Wired NFT game.
/// @notice Combines two trust models so a player can't fake progress:
///
///  - Model B (server-gated entry): a run can only be started with a `Ticket`
///    signed by the trusted game server (LainOS). The 3D client cannot forge
///    that signature, so entry/difficulty is authorised off-chain and the
///    server can rate-limit and bind tickets to real sessions.
///
///  - Model C (on-chain achievement): the artifact is *earned* by winning a
///    deterministic turn-based duel where every move is a transaction the
///    contract validates. There is no way to obtain a token except by actually
///    driving the ICE's HP to zero on-chain — provably done, not claimed.
///
/// The ICE's moves are derived from the run seed and are therefore knowable to
/// the player (no hidden storage advantage): this is a strategy/timing duel,
/// not a guessing game. The point is that completion is unforgeable, not that
/// information is hidden. (A VRF/commit-reveal upgrade can add unpredictability.)
contract WiredForge is ERC721URIStorage, EIP712, AccessManaged {
    using Strings for uint256;

    /// Trusted signer (the LainOS game server) authorising run entry.
    address public signer;

    /// Player moves.
    uint8 public constant MOVE_STRIKE = 0;
    uint8 public constant MOVE_GUARD = 1;
    uint8 public constant MOVE_OVERLOAD = 2;

    struct Ticket {
        address player;
        uint8 tier; // difficulty from the 3D session
        bytes32 seed; // server-chosen; drives the ICE
        uint256 nonce; // unique per ticket
        uint256 deadline; // unix expiry
    }

    struct Run {
        bool active;
        uint8 tier;
        bytes32 seed;
        uint16 playerHp;
        uint16 iceHp;
        uint8 turn;
        uint8 maxTurns;
    }

    mapping(address => Run) public runs;
    mapping(uint256 => bool) public usedNonce;
    uint256 public nextId;

    bytes32 private constant TICKET_TYPEHASH =
        keccak256("Ticket(address player,uint8 tier,bytes32 seed,uint256 nonce,uint256 deadline)");

    event RunStarted(address indexed player, uint8 tier, bytes32 seed, uint16 iceHp, uint8 maxTurns);
    event Turn(address indexed player, uint8 playerMove, uint8 iceMove, uint16 playerHp, uint16 iceHp, uint8 turn);
    event Cracked(address indexed player, uint256 indexed tokenId, uint8 tier);
    event Failed(address indexed player, uint8 turn);

    constructor(address authority, address signer_)
        ERC721("Wired Artifact", "WIRED")
        EIP712("WiredForge", "1")
        AccessManaged(authority)
    {
        require(signer_ != address(0), "signer=0");
        signer = signer_;
    }

    function setSigner(address newSigner) external restricted {
        require(newSigner != address(0), "signer=0");
        signer = newSigner;
    }

    // -------------------------------------------------------- model B: entry

    /// @notice Start a duel using a server-signed ticket.
    function startRun(Ticket calldata t, bytes calldata sig) external {
        require(t.player == msg.sender, "not your ticket");
        require(block.timestamp <= t.deadline, "ticket expired");
        require(!usedNonce[t.nonce], "ticket used");
        require(!runs[msg.sender].active, "run in progress");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TICKET_TYPEHASH, t.player, t.tier, t.seed, t.nonce, t.deadline))
        );
        require(ECDSA.recover(digest, sig) == signer, "bad signature");

        usedNonce[t.nonce] = true;

        uint16 iceHp = uint16(20 + uint16(t.tier) * 10);
        uint8 maxTurns = uint8(8 + uint8(t.tier) * 2);
        runs[msg.sender] = Run({
            active: true,
            tier: t.tier,
            seed: t.seed,
            playerHp: 20,
            iceHp: iceHp,
            turn: 0,
            maxTurns: maxTurns
        });

        emit RunStarted(msg.sender, t.tier, t.seed, iceHp, maxTurns);
    }

    // --------------------------------------------------- model C: the duel

    /// @notice The ICE's deterministic move for a given seed and turn.
    /// Pure + public so the UI can show it: this is a strategy duel.
    function previewIceMove(bytes32 seed, uint8 turn) public pure returns (uint8) {
        return uint8(uint256(keccak256(abi.encodePacked(seed, turn))) % 3);
    }

    /// @notice Take one turn. Winning the duel mints the artifact.
    function act(uint8 move) external {
        Run storage r = runs[msg.sender];
        require(r.active, "no run");
        require(move <= MOVE_OVERLOAD, "bad move");
        require(r.turn < r.maxTurns, "out of turns");

        uint8 iceMove = previewIceMove(r.seed, r.turn);

        // Damage the player deals to the ICE.
        uint16 toIce = 0;
        if (move == MOVE_STRIKE) {
            toIce = (iceMove == MOVE_GUARD) ? 2 : 6;
        } else if (move == MOVE_OVERLOAD) {
            toIce = (iceMove == MOVE_GUARD) ? 4 : 10;
        }

        // Damage the ICE deals back — negated if the player guarded.
        uint16 toPlayer = 0;
        if (move != MOVE_GUARD) {
            if (iceMove == MOVE_STRIKE) toPlayer = 5;
            else if (iceMove == MOVE_OVERLOAD) toPlayer = 8;
        }

        r.iceHp = toIce >= r.iceHp ? 0 : r.iceHp - toIce;
        r.playerHp = toPlayer >= r.playerHp ? 0 : r.playerHp - toPlayer;
        r.turn += 1;

        emit Turn(msg.sender, move, iceMove, r.playerHp, r.iceHp, r.turn);

        if (r.iceHp == 0) {
            r.active = false;
            uint256 id = ++nextId;
            uint8 tier = r.tier;
            _safeMint(msg.sender, id);
            _setTokenURI(id, _artifactUri(tier, id));
            emit Cracked(msg.sender, id, tier);
        } else if (r.playerHp == 0 || r.turn >= r.maxTurns) {
            r.active = false;
            emit Failed(msg.sender, r.turn);
        }
    }

    function _artifactUri(uint8 tier, uint256 id) internal pure returns (string memory) {
        return string(abi.encodePacked("wired:artifact:", id.toString(), ":tier", uint256(tier).toString()));
    }
}
