// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Open-ended challenges; ten-minute phases only after mutual readiness.
/// @dev A separate immutable deployment. The original RPS contract is unchanged.
contract RockPaperScissorsAsync is ReentrancyGuard {
    // Preserve the original tuple and state numbers for existing wallet clients.
    enum GameState { None, WaitingForPlayer, Commit, Reveal, Resolved, Cancelled, WaitingForReady }
    enum Move { None, Rock, Paper, Scissors }
    enum Result { None, PlayerOneWins, PlayerTwoWins, Draw, TimedOut }

    struct Game {
        address playerOne;
        address playerTwo;
        uint96 stake;
        uint64 deadline;
        GameState state;
        Result result;
        address winner;
        bytes32 playerOneCommitment;
        bytes32 playerTwoCommitment;
        Move playerOneMove;
        Move playerTwoMove;
    }

    error DeadlineExpired(uint256 deadline);
    error DeadlineNotReached(uint256 deadline);
    error GameNotFound(uint256 gameId);
    error IncorrectStake(uint256 expected, uint256 received);
    error InvalidCommitment();
    error InvalidMove();
    error InvalidPhase(GameState expected, GameState actual);
    error InvalidTreasury();
    error NoPayout();
    error NotPlayer();
    error SamePlayer();
    error StakeTooLarge();
    error TransferFailed();
    error ZeroStake();

    event GameCreated(uint256 indexed gameId, address indexed playerOne, uint256 stake, uint256 deadline);
    event PlayerJoined(uint256 indexed gameId, address indexed playerTwo, uint256 deadline);
    event PlayerReady(uint256 indexed gameId, address indexed player, uint256 validUntil);
    event GameStarted(uint256 indexed gameId, uint256 deadline);
    event MoveCommitted(uint256 indexed gameId, address indexed player);
    event MoveRevealed(uint256 indexed gameId, address indexed player, Move move);
    event GameResolved(uint256 indexed gameId, Result result, address indexed winner);
    event GameCancelled(uint256 indexed gameId);
    event GameTimedOut(uint256 indexed gameId, bool playerOneInactive, bool playerTwoInactive, uint256 treasuryAmount);
    event PayoutClaimed(uint256 indexed gameId, address indexed player, uint256 amount);
    event TreasuryClaimed(uint256 indexed gameId, address indexed treasury, uint256 amount);

    uint256 public constant rulesVersion = 2;
    uint64 public constant phaseDuration = 600;
    address public immutable treasury;
    uint256 public nextGameId = 1;

    mapping(uint256 gameId => Game game) private games;
    mapping(uint256 gameId => mapping(address player => uint64 until)) public readyUntil;
    mapping(uint256 gameId => mapping(address player => uint256 amount)) public pendingPayout;
    mapping(uint256 gameId => uint256 amount) public pendingTreasury;

    constructor(address treasury_) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        treasury = treasury_;
    }

    function createGame() external payable returns (uint256 gameId) {
        if (msg.value == 0) revert ZeroStake();
        if (msg.value > type(uint96).max) revert StakeTooLarge();
        gameId = nextGameId++;
        Game storage game = games[gameId];
        game.playerOne = msg.sender;
        game.stake = uint96(msg.value);
        game.state = GameState.WaitingForPlayer;
        emit GameCreated(gameId, msg.sender, msg.value, 0);
    }

    function joinGame(uint256 gameId) external payable {
        Game storage game = _game(gameId);
        _requirePhase(game, GameState.WaitingForPlayer);
        if (msg.sender == game.playerOne) revert SamePlayer();
        if (msg.value != game.stake) revert IncorrectStake(game.stake, msg.value);
        game.playerTwo = msg.sender;
        game.state = GameState.WaitingForReady;
        emit PlayerJoined(gameId, msg.sender, 0);
    }

    function confirmReady(uint256 gameId) external {
        Game storage game = _game(gameId);
        _requirePhase(game, GameState.WaitingForReady);
        _requirePlayer(game);
        uint64 until = _nextDeadline();
        readyUntil[gameId][msg.sender] = until;
        emit PlayerReady(gameId, msg.sender, until);
        // An old acknowledgement cannot start a match while its author is away.
        if (readyUntil[gameId][game.playerOne] >= block.timestamp
            && readyUntil[gameId][game.playerTwo] >= block.timestamp) {
            game.state = GameState.Commit;
            game.deadline = until;
            emit GameStarted(gameId, until);
        }
    }

    /// @notice Either participant can leave before mutual readiness, without penalty.
    function cancelBeforeStart(uint256 gameId) external {
        Game storage game = _game(gameId);
        _requirePlayer(game);
        if (game.state != GameState.WaitingForPlayer && game.state != GameState.WaitingForReady) {
            revert InvalidPhase(GameState.WaitingForReady, game.state);
        }
        game.state = GameState.Cancelled;
        pendingPayout[gameId][game.playerOne] = game.stake;
        if (game.playerTwo != address(0)) pendingPayout[gameId][game.playerTwo] = game.stake;
        emit GameCancelled(gameId);
    }

    function commitMove(uint256 gameId, bytes32 commitment) external {
        Game storage game = _game(gameId);
        _requirePhase(game, GameState.Commit);
        if (block.timestamp > game.deadline) revert DeadlineExpired(game.deadline);
        if (commitment == bytes32(0)) revert InvalidCommitment();
        _requirePlayer(game);
        if (msg.sender == game.playerOne) {
            if (game.playerOneCommitment != bytes32(0)) revert InvalidCommitment();
            game.playerOneCommitment = commitment;
        } else {
            if (game.playerTwoCommitment != bytes32(0)) revert InvalidCommitment();
            game.playerTwoCommitment = commitment;
        }
        emit MoveCommitted(gameId, msg.sender);
        if (game.playerOneCommitment != bytes32(0) && game.playerTwoCommitment != bytes32(0)) {
            game.state = GameState.Reveal;
            game.deadline = _nextDeadline();
        }
    }

    function revealMove(uint256 gameId, Move move, bytes32 secret) external {
        Game storage game = _game(gameId);
        _requirePhase(game, GameState.Reveal);
        if (block.timestamp > game.deadline) revert DeadlineExpired(game.deadline);
        if (move == Move.None) revert InvalidMove();
        _requirePlayer(game);
        bytes32 expected = hashMove(gameId, msg.sender, move, secret);
        if (msg.sender == game.playerOne) {
            if (game.playerOneMove != Move.None || expected != game.playerOneCommitment) revert InvalidCommitment();
            game.playerOneMove = move;
        } else {
            if (game.playerTwoMove != Move.None || expected != game.playerTwoCommitment) revert InvalidCommitment();
            game.playerTwoMove = move;
        }
        emit MoveRevealed(gameId, msg.sender, move);
    }

    function resolveGame(uint256 gameId) external {
        Game storage game = _game(gameId);
        _requirePhase(game, GameState.Reveal);
        if (game.playerOneMove == Move.None || game.playerTwoMove == Move.None) revert InvalidMove();
        _resolve(gameId, game);
    }

    function cancelExpiredGame(uint256 gameId) external {
        Game storage game = _game(gameId);
        if (game.state != GameState.Commit && game.state != GameState.Reveal) {
            revert InvalidPhase(GameState.Commit, game.state);
        }
        if (block.timestamp <= game.deadline) revert DeadlineNotReached(game.deadline);
        bool oneActed;
        bool twoActed;
        if (game.state == GameState.Commit) {
            oneActed = game.playerOneCommitment != bytes32(0);
            twoActed = game.playerTwoCommitment != bytes32(0);
        } else {
            oneActed = game.playerOneMove != Move.None;
            twoActed = game.playerTwoMove != Move.None;
            if (oneActed && twoActed) {
                _resolve(gameId, game);
                return;
            }
        }
        game.state = GameState.Cancelled;
        game.result = Result.TimedOut;
        uint256 penalty;
        if (oneActed) pendingPayout[gameId][game.playerOne] = game.stake;
        else penalty += game.stake;
        if (twoActed) pendingPayout[gameId][game.playerTwo] = game.stake;
        else penalty += game.stake;
        pendingTreasury[gameId] = penalty;
        emit GameTimedOut(gameId, !oneActed, !twoActed, penalty);
    }

    function claimPayout(uint256 gameId) external nonReentrant {
        uint256 amount = pendingPayout[gameId][msg.sender];
        if (amount == 0) revert NoPayout();
        pendingPayout[gameId][msg.sender] = 0;
        _transfer(msg.sender, amount);
        emit PayoutClaimed(gameId, msg.sender, amount);
    }

    /// @notice Anyone can deliver an accrued penalty, but only to the fixed treasury.
    function claimTreasury(uint256 gameId) external nonReentrant {
        uint256 amount = pendingTreasury[gameId];
        if (amount == 0) revert NoPayout();
        pendingTreasury[gameId] = 0;
        _transfer(treasury, amount);
        emit TreasuryClaimed(gameId, treasury, amount);
    }

    function getGame(uint256 gameId) external view returns (Game memory) { return _game(gameId); }

    function hashMove(uint256 gameId, address player, Move move, bytes32 secret) public view returns (bytes32) {
        if (move == Move.None) revert InvalidMove();
        return keccak256(abi.encode(address(this), block.chainid, gameId, player, move, secret));
    }

    function _resolve(uint256 gameId, Game storage game) private {
        game.state = GameState.Resolved;
        if (game.playerOneMove == game.playerTwoMove) {
            game.result = Result.Draw;
            pendingPayout[gameId][game.playerOne] = game.stake;
            pendingPayout[gameId][game.playerTwo] = game.stake;
        } else {
            bool oneWins = (game.playerOneMove == Move.Rock && game.playerTwoMove == Move.Scissors)
                || (game.playerOneMove == Move.Paper && game.playerTwoMove == Move.Rock)
                || (game.playerOneMove == Move.Scissors && game.playerTwoMove == Move.Paper);
            game.winner = oneWins ? game.playerOne : game.playerTwo;
            game.result = oneWins ? Result.PlayerOneWins : Result.PlayerTwoWins;
            pendingPayout[gameId][game.winner] = uint256(game.stake) * 2;
        }
        emit GameResolved(gameId, game.result, game.winner);
    }

    function _transfer(address recipient, uint256 amount) private {
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _game(uint256 gameId) private view returns (Game storage game) {
        game = games[gameId];
        if (game.state == GameState.None) revert GameNotFound(gameId);
    }

    function _requirePlayer(Game storage game) private view {
        if (msg.sender != game.playerOne && msg.sender != game.playerTwo) revert NotPlayer();
    }

    function _requirePhase(Game storage game, GameState expected) private view {
        if (game.state != expected) revert InvalidPhase(expected, game.state);
    }

    function _nextDeadline() private view returns (uint64) { return uint64(block.timestamp) + phaseDuration; }
}
