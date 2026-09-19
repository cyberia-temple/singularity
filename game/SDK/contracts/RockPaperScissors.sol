// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Cyberia Arcade Rock–Paper–Scissors
/// @notice Two-player escrow game with domain-separated commit–reveal moves.
contract RockPaperScissors is ReentrancyGuard {
    enum GameState {
        None,
        WaitingForPlayer,
        Commit,
        Reveal,
        Resolved,
        Cancelled
    }

    enum Move {
        None,
        Rock,
        Paper,
        Scissors
    }

    enum Result {
        None,
        PlayerOneWins,
        PlayerTwoWins,
        Draw
    }

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
    error NoPayout();
    error NotPlayer();
    error SamePlayer();
    error StakeTooLarge();
    error TransferFailed();
    error ZeroStake();
    error ZeroTimeout();

    event GameCreated(uint256 indexed gameId, address indexed playerOne, uint256 stake, uint256 deadline);
    event PlayerJoined(uint256 indexed gameId, address indexed playerTwo, uint256 deadline);
    event MoveCommitted(uint256 indexed gameId, address indexed player);
    event MoveRevealed(uint256 indexed gameId, address indexed player, Move move);
    event GameResolved(uint256 indexed gameId, Result result, address indexed winner);
    event GameCancelled(uint256 indexed gameId);
    event PayoutClaimed(uint256 indexed gameId, address indexed player, uint256 amount);

    uint64 public immutable phaseDuration;
    uint256 public nextGameId = 1;

    mapping(uint256 gameId => Game game) private games;
    mapping(uint256 gameId => mapping(address player => uint256 amount)) public pendingPayout;

    constructor(uint64 phaseDuration_) {
        if (phaseDuration_ == 0) revert ZeroTimeout();
        phaseDuration = phaseDuration_;
    }

    function createGame() external payable returns (uint256 gameId) {
        if (msg.value == 0) revert ZeroStake();
        if (msg.value > type(uint96).max) revert StakeTooLarge();

        gameId = nextGameId++;
        uint64 deadline = _nextDeadline();
        games[gameId] = Game({
            playerOne: msg.sender,
            playerTwo: address(0),
            stake: uint96(msg.value),
            deadline: deadline,
            state: GameState.WaitingForPlayer,
            result: Result.None,
            winner: address(0),
            playerOneCommitment: bytes32(0),
            playerTwoCommitment: bytes32(0),
            playerOneMove: Move.None,
            playerTwoMove: Move.None
        });

        emit GameCreated(gameId, msg.sender, msg.value, deadline);
    }

    function joinGame(uint256 gameId) external payable {
        Game storage game = _game(gameId);
        _requirePhase(game, GameState.WaitingForPlayer);
        if (block.timestamp > game.deadline) revert DeadlineExpired(game.deadline);
        if (msg.sender == game.playerOne) revert SamePlayer();
        if (msg.value != game.stake) revert IncorrectStake(game.stake, msg.value);

        game.playerTwo = msg.sender;
        game.state = GameState.Commit;
        game.deadline = _nextDeadline();

        emit PlayerJoined(gameId, msg.sender, game.deadline);
    }

    function commitMove(uint256 gameId, bytes32 commitment) external {
        Game storage game = _game(gameId);
        _requirePhase(game, GameState.Commit);
        if (block.timestamp > game.deadline) revert DeadlineExpired(game.deadline);
        if (commitment == bytes32(0)) revert InvalidCommitment();

        if (msg.sender == game.playerOne) {
            if (game.playerOneCommitment != bytes32(0)) revert InvalidCommitment();
            game.playerOneCommitment = commitment;
        } else if (msg.sender == game.playerTwo) {
            if (game.playerTwoCommitment != bytes32(0)) revert InvalidCommitment();
            game.playerTwoCommitment = commitment;
        } else {
            revert NotPlayer();
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

        bytes32 expected = hashMove(gameId, msg.sender, move, secret);
        if (msg.sender == game.playerOne) {
            if (game.playerOneMove != Move.None || expected != game.playerOneCommitment) {
                revert InvalidCommitment();
            }
            game.playerOneMove = move;
        } else if (msg.sender == game.playerTwo) {
            if (game.playerTwoMove != Move.None || expected != game.playerTwoCommitment) {
                revert InvalidCommitment();
            }
            game.playerTwoMove = move;
        } else {
            revert NotPlayer();
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
        if (block.timestamp <= game.deadline) revert DeadlineNotReached(game.deadline);

        if (game.state == GameState.WaitingForPlayer) {
            game.state = GameState.Cancelled;
            pendingPayout[gameId][game.playerOne] = game.stake;
            emit GameCancelled(gameId);
            return;
        }

        if (game.state == GameState.Commit) {
            bool playerOneCommitted = game.playerOneCommitment != bytes32(0);
            bool playerTwoCommitted = game.playerTwoCommitment != bytes32(0);
            if (playerOneCommitted != playerTwoCommitted) {
                _award(gameId, game, playerOneCommitted ? game.playerOne : game.playerTwo);
            } else {
                _refund(gameId, game);
            }
            return;
        }

        if (game.state == GameState.Reveal) {
            bool playerOneRevealed = game.playerOneMove != Move.None;
            bool playerTwoRevealed = game.playerTwoMove != Move.None;
            if (playerOneRevealed && playerTwoRevealed) {
                _resolve(gameId, game);
            } else if (playerOneRevealed != playerTwoRevealed) {
                _award(gameId, game, playerOneRevealed ? game.playerOne : game.playerTwo);
            } else {
                _refund(gameId, game);
            }
            return;
        }

        revert InvalidPhase(GameState.WaitingForPlayer, game.state);
    }

    function claimPayout(uint256 gameId) external nonReentrant {
        uint256 amount = pendingPayout[gameId][msg.sender];
        if (amount == 0) revert NoPayout();

        pendingPayout[gameId][msg.sender] = 0;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit PayoutClaimed(gameId, msg.sender, amount);
    }

    function getGame(uint256 gameId) external view returns (Game memory) {
        return _game(gameId);
    }

    function hashMove(uint256 gameId, address player, Move move, bytes32 secret) public view returns (bytes32) {
        if (move == Move.None) revert InvalidMove();
        return keccak256(abi.encode(address(this), block.chainid, gameId, player, move, secret));
    }

    function _resolve(uint256 gameId, Game storage game) private {
        if (game.playerOneMove == game.playerTwoMove) {
            game.state = GameState.Resolved;
            game.result = Result.Draw;
            pendingPayout[gameId][game.playerOne] = game.stake;
            pendingPayout[gameId][game.playerTwo] = game.stake;
            emit GameResolved(gameId, Result.Draw, address(0));
            return;
        }

        bool playerOneWins = (game.playerOneMove == Move.Rock && game.playerTwoMove == Move.Scissors)
            || (game.playerOneMove == Move.Paper && game.playerTwoMove == Move.Rock)
            || (game.playerOneMove == Move.Scissors && game.playerTwoMove == Move.Paper);
        _award(gameId, game, playerOneWins ? game.playerOne : game.playerTwo);
    }

    function _award(uint256 gameId, Game storage game, address winner) private {
        game.state = GameState.Resolved;
        game.winner = winner;
        game.result = winner == game.playerOne ? Result.PlayerOneWins : Result.PlayerTwoWins;
        pendingPayout[gameId][winner] = uint256(game.stake) * 2;
        emit GameResolved(gameId, game.result, winner);
    }

    function _refund(uint256 gameId, Game storage game) private {
        game.state = GameState.Cancelled;
        pendingPayout[gameId][game.playerOne] = game.stake;
        pendingPayout[gameId][game.playerTwo] = game.stake;
        emit GameCancelled(gameId);
    }

    function _game(uint256 gameId) private view returns (Game storage game) {
        game = games[gameId];
        if (game.state == GameState.None) revert GameNotFound(gameId);
    }

    function _requirePhase(Game storage game, GameState expected) private view {
        if (game.state != expected) revert InvalidPhase(expected, game.state);
    }

    function _nextDeadline() private view returns (uint64) {
        return uint64(block.timestamp) + phaseDuration;
    }
}
