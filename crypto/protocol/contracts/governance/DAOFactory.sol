// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import {TimelockControllerUpgradeable} from "@openzeppelin/contracts-upgradeable/governance/TimelockControllerUpgradeable.sol";

import {IDAOFactory} from "../launch/interfaces/IEconomyModules.sol";
import {TokenGovernor} from "./TokenGovernor.sol";
import {VotesWrapper} from "./VotesWrapper.sol";

/// @title A DAO for any token, in one call
/// @notice A DAO here is a governor voted by the token and a timelock that holds whatever the DAO
/// owns and executes what it decides. Nobody keeps an admin key: the factory hands every role to the
/// governor and renounces its own in the same transaction.
///
///  - `createDAO(token)` -- the defaults, for any token that votes on a timestamp clock (every token
///    launched here, and ASH). This is what a launch's kit calls.
///  - `createCustomDAO(token, params)` -- your own delays, threshold and quorum.
///  - `createWrappedDAO(token, params)` -- for a token that cannot vote: holders wrap it one-for-one
///    into a `VotesWrapper` and vote with that.
contract DAOFactory is IDAOFactory {
    uint256 internal constant BPS = 10_000;

    struct Params {
        uint48 votingDelay;
        uint32 votingPeriod;
        /// @dev share of the token's supply at creation needed to propose, in basis points
        uint16 proposalThresholdBps;
        uint8 quorumPercent;
        uint32 timelockDelay;
    }

    struct DAO {
        address token;
        address governor;
        address timelock;
        address wrapper;
    }

    address public immutable governorImplementation;
    address public immutable timelockImplementation;
    address public immutable wrapperImplementation;

    mapping(address token => DAO[]) internal _daosOf;
    DAO[] public allDAOs;

    event DAOCreated(address indexed token, address governor, address timelock, address wrapper, address indexed creator);

    error NotTimestampVotes();
    error BadParams();

    constructor() {
        governorImplementation = address(new TokenGovernor());
        timelockImplementation = address(new TimelockControllerUpgradeable());
        wrapperImplementation = address(new VotesWrapper());
    }

    function defaults() public pure returns (Params memory) {
        return Params({
            votingDelay: 1 days,
            votingPeriod: 5 days,
            proposalThresholdBps: 50,
            quorumPercent: 4,
            timelockDelay: 2 days
        });
    }

    /// @inheritdoc IDAOFactory
    function createDAO(address token) external returns (address governor, address timelock) {
        (governor, timelock) = _create(token, address(0), defaults());
    }

    function createCustomDAO(address token, Params calldata params) external returns (address governor, address timelock) {
        (governor, timelock) = _create(token, address(0), params);
    }

    function createWrappedDAO(address token, Params calldata params)
        external
        returns (address governor, address timelock, address wrapper)
    {
        wrapper = Clones.clone(wrapperImplementation);
        string memory symbol = _symbol(token);
        VotesWrapper(wrapper).initialize(IERC20(token), string.concat("Voting ", symbol), string.concat("v", symbol));
        (governor, timelock) = _create(wrapper, wrapper, params);
    }

    function daosOf(address token) external view returns (DAO[] memory) {
        return _daosOf[token];
    }

    function allDAOsLength() external view returns (uint256) {
        return allDAOs.length;
    }

    function _create(address votesToken, address wrapper, Params memory p)
        internal
        returns (address governor, address timelock)
    {
        if (p.votingPeriod == 0 || p.quorumPercent == 0 || p.quorumPercent > 100 || p.proposalThresholdBps > BPS) {
            revert BadParams();
        }
        if (keccak256(bytes(IERC6372(votesToken).CLOCK_MODE())) != keccak256("mode=timestamp")) {
            revert NotTimestampVotes();
        }

        governor = Clones.clone(governorImplementation);
        timelock = Clones.clone(timelockImplementation);

        // Proposers (and so cancellers) are the governor alone; anyone may execute what passed.
        address[] memory proposers = new address[](1);
        proposers[0] = governor;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockControllerUpgradeable(payable(timelock)).initialize(p.timelockDelay, proposers, executors, address(0));

        string memory symbol = _symbol(votesToken);
        uint256 threshold = IERC20(votesToken).totalSupply() * p.proposalThresholdBps / BPS;
        TokenGovernor(payable(governor)).initialize(
            string.concat(symbol, " DAO"),
            IVotes(votesToken),
            TimelockControllerUpgradeable(payable(timelock)),
            p.votingDelay,
            p.votingPeriod,
            threshold,
            p.quorumPercent
        );

        address underlying = wrapper == address(0) ? votesToken : address(VotesWrapper(wrapper).underlying());
        DAO memory dao = DAO(underlying, governor, timelock, wrapper);
        _daosOf[underlying].push(dao);
        allDAOs.push(dao);

        emit DAOCreated(underlying, governor, timelock, wrapper, msg.sender);
    }

    function _symbol(address token) internal view returns (string memory) {
        try IERC20Metadata(token).symbol() returns (string memory s) {
            return s;
        } catch {
            return "TOKEN";
        }
    }
}
