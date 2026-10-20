// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {Epoch} from "../libraries/Epoch.sol";
import {VotingEscrow} from "./VotingEscrow.sol";
import {Gauge} from "./Gauge.sol";
import {IGaugeRegistry} from "../launch/interfaces/IEconomyModules.sol";

/// @title Where ASH goes is decided by the people who lock it
/// @notice Every week, veASH holders split their voting power between gauges. Next week's emission
/// is divided between gauges in exactly those proportions -- so liquidity goes where the lockers
/// send it, and lockers send it where it pays them to:
///
///  - **Incentives.** Anyone can pay a gauge's voters for the week: a project wanting liquidity for
///    its token, or the protocol routing a pool's own trading fees back to the people who voted for
///    that pool. Voters claim them once the week is over, in proportion to their votes.
///  - **Emissions.** The `Minter` hands this contract each week's ASH; `distribute` sends each gauge
///    its share by last week's votes.
///
/// @dev Votes belong to one epoch and are cast again each week -- nothing to checkpoint, and nothing
/// stale that someone must remember to poke. Locks end on epoch boundaries, so the same ASH can
/// never vote twice in one week.
contract Voter is AccessManaged, ReentrancyGuardTransient, IGaugeRegistry {
    using SafeERC20 for IERC20;

    /// @notice The most gauges one vote may split between
    uint256 public constant MAX_GAUGES_PER_VOTE = 30;

    VotingEscrow public immutable ve;
    IERC20 public immutable ash;
    address public immutable gaugeImplementation;

    address public minter;
    /// @notice Receives emission nobody voted for and emission of retired gauges
    address public treasury;

    mapping(address stakingToken => address gauge) public gaugeOf;
    mapping(address gauge => bool) public isGauge;
    mapping(address gauge => bool) public isAlive;
    address[] public allGauges;

    mapping(uint256 epoch => mapping(address voter => mapping(address gauge => uint256))) public votes;
    mapping(uint256 epoch => mapping(address voter => address[])) internal _votedGauges;
    mapping(uint256 epoch => mapping(address gauge => uint256)) public gaugeVotes;
    mapping(uint256 epoch => uint256) public totalVotes;

    mapping(uint256 epoch => uint256) public emission;
    mapping(uint256 epoch => mapping(address gauge => bool)) public distributed;
    mapping(uint256 epoch => bool) public unvotedSwept;

    mapping(uint256 epoch => mapping(address gauge => mapping(address token => uint256))) public incentives;
    mapping(uint256 epoch => mapping(address gauge => mapping(address token => mapping(address voter => bool)))) public
        incentiveClaimed;

    event GaugeCreated(address indexed stakingToken, address indexed gauge, address manager);
    event GaugeKilled(address indexed gauge);
    event GaugeRevived(address indexed gauge);
    event Voted(uint256 indexed epoch, address indexed voter, address indexed gauge, uint256 weight);
    event VoteReset(uint256 indexed epoch, address indexed voter);
    event EmissionNotified(uint256 indexed epoch, uint256 amount);
    event Distributed(uint256 indexed epoch, address indexed gauge, uint256 amount);
    event Incentivized(uint256 indexed epoch, address indexed gauge, address indexed token, address from, uint256 amount);
    event IncentiveClaimed(uint256 indexed epoch, address indexed gauge, address indexed token, address voter, uint256 amount);
    event IncentiveRolledOver(uint256 indexed fromEpoch, address indexed gauge, address indexed token, uint256 amount);
    event MinterSet(address indexed minter);
    event TreasurySet(address indexed treasury);

    error GaugeExists();
    error NotGauge();
    error GaugeNotAlive();
    error NoVotingPower();
    error BadVote();
    error NotMinter();
    error MinterAlreadySet();
    error EpochNotOver();
    error FutureEpoch();
    error NothingToDistribute();
    error AlreadyDone();
    error NothingToClaim();
    error ZeroAddress();

    constructor(address authority, VotingEscrow ve_, address treasury_) AccessManaged(authority) {
        if (treasury_ == address(0)) revert ZeroAddress();
        ve = ve_;
        ash = ve_.ash();
        treasury = treasury_;
        gaugeImplementation = address(new Gauge());
    }

    // --------------------------------------------------------------------------------- gauges

    /// @inheritdoc IGaugeRegistry
    /// @dev Restricted: a gauge is a claim on emissions, so governance and the launchpad decide what
    /// gets one. `manager` may stream extra rewards into it.
    function createGauge(address stakingToken, address manager) external restricted returns (address gauge) {
        if (gaugeOf[stakingToken] != address(0)) revert GaugeExists();

        gauge = Clones.clone(gaugeImplementation);
        Gauge(gauge).initialize(IERC20(stakingToken), address(ash), manager);

        gaugeOf[stakingToken] = gauge;
        isGauge[gauge] = true;
        isAlive[gauge] = true;
        allGauges.push(gauge);

        emit GaugeCreated(stakingToken, gauge, manager);
    }

    function killGauge(address gauge) external restricted {
        if (!isAlive[gauge]) revert GaugeNotAlive();
        isAlive[gauge] = false;
        emit GaugeKilled(gauge);
    }

    function reviveGauge(address gauge) external restricted {
        if (!isGauge[gauge] || isAlive[gauge]) revert NotGauge();
        isAlive[gauge] = true;
        emit GaugeRevived(gauge);
    }

    function allGaugesLength() external view returns (uint256) {
        return allGauges.length;
    }

    // ---------------------------------------------------------------------------------- votes

    /// @notice Split your voting power between gauges for this week, replacing any earlier split
    function vote(address[] calldata gauges, uint256[] calldata weights) external nonReentrant {
        if (gauges.length == 0 || gauges.length != weights.length || gauges.length > MAX_GAUGES_PER_VOTE) {
            revert BadVote();
        }

        uint256 epoch = Epoch.current();
        _reset(epoch, msg.sender);

        uint256 power = ve.votingPower(msg.sender);
        if (power == 0) revert NoVotingPower();

        uint256 totalWeight;
        for (uint256 i = 0; i < weights.length; i++) {
            totalWeight += weights[i];
        }
        if (totalWeight == 0) revert BadVote();

        uint256 used;
        for (uint256 i = 0; i < gauges.length; i++) {
            address gauge = gauges[i];
            if (!isAlive[gauge]) revert GaugeNotAlive();
            if (votes[epoch][msg.sender][gauge] != 0) revert BadVote(); // listed twice

            uint256 weight = power * weights[i] / totalWeight;
            if (weight == 0) revert BadVote();

            votes[epoch][msg.sender][gauge] = weight;
            _votedGauges[epoch][msg.sender].push(gauge);
            gaugeVotes[epoch][gauge] += weight;
            used += weight;

            emit Voted(epoch, msg.sender, gauge, weight);
        }
        totalVotes[epoch] += used;
    }

    /// @notice Withdraw this week's votes
    function reset() external nonReentrant {
        _reset(Epoch.current(), msg.sender);
    }

    function votedGauges(uint256 epoch, address voter) external view returns (address[] memory) {
        return _votedGauges[epoch][voter];
    }

    function _reset(uint256 epoch, address voter) internal {
        address[] storage voted = _votedGauges[epoch][voter];
        uint256 n = voted.length;
        if (n == 0) return;

        uint256 released;
        for (uint256 i = 0; i < n; i++) {
            address gauge = voted[i];
            uint256 weight = votes[epoch][voter][gauge];
            gaugeVotes[epoch][gauge] -= weight;
            released += weight;
            delete votes[epoch][voter][gauge];
        }
        totalVotes[epoch] -= released;
        delete _votedGauges[epoch][voter];

        emit VoteReset(epoch, voter);
    }

    // ------------------------------------------------------------------------------ emissions

    /// @notice This week's ASH, from the minter
    function notifyRewardAmount(uint256 amount) external nonReentrant {
        if (msg.sender != minter) revert NotMinter();
        uint256 epoch = Epoch.current();
        ash.safeTransferFrom(msg.sender, address(this), amount);
        emission[epoch] += amount;
        emit EmissionNotified(epoch, amount);
    }

    /// @notice Send `gauge` its share of `epoch`'s emission, by the votes cast the week before
    function distribute(address gauge, uint256 epoch) public nonReentrant {
        if (epoch > Epoch.current()) revert FutureEpoch();
        if (!isGauge[gauge]) revert NotGauge();
        if (emission[epoch] == 0) revert NothingToDistribute();
        if (distributed[epoch][gauge]) revert AlreadyDone();
        distributed[epoch][gauge] = true;

        uint256 total = totalVotes[epoch - 1];
        uint256 amount = total == 0 ? 0 : emission[epoch] * gaugeVotes[epoch - 1][gauge] / total;
        if (amount == 0) return;

        if (isAlive[gauge]) {
            ash.forceApprove(gauge, amount);
            Gauge(gauge).notifyRewardAmount(address(ash), amount);
        } else {
            ash.safeTransfer(treasury, amount);
        }
        emit Distributed(epoch, gauge, amount);
    }

    function distributeMany(address[] calldata gauges, uint256 epoch) external {
        for (uint256 i = 0; i < gauges.length; i++) {
            if (!distributed[epoch][gauges[i]]) distribute(gauges[i], epoch);
        }
    }

    /// @notice A week nobody voted in leaves its emission with nobody to send it to: the treasury
    function sweepUnvoted(uint256 epoch) external nonReentrant {
        if (epoch > Epoch.current()) revert FutureEpoch();
        if (totalVotes[epoch - 1] != 0 || emission[epoch] == 0) revert NothingToDistribute();
        if (unvotedSwept[epoch]) revert AlreadyDone();
        unvotedSwept[epoch] = true;
        ash.safeTransfer(treasury, emission[epoch]);
    }

    // ----------------------------------------------------------------------------- incentives

    /// @notice Pay this week's voters of `gauge`
    function incentivize(address gauge, address token, uint256 amount) external nonReentrant {
        if (!isGauge[gauge]) revert NotGauge();
        uint256 epoch = Epoch.current();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;

        incentives[epoch][gauge][token] += received;
        emit Incentivized(epoch, gauge, token, msg.sender, received);
    }

    /// @notice Claim what a finished week's voters of `gauge` were paid, in the listed tokens
    function claimIncentives(uint256 epoch, address gauge, address[] calldata tokens)
        external
        nonReentrant
        returns (uint256[] memory amounts)
    {
        if (epoch >= Epoch.current()) revert EpochNotOver();
        uint256 weight = votes[epoch][msg.sender][gauge];
        if (weight == 0) revert NothingToClaim();
        uint256 total = gaugeVotes[epoch][gauge];

        amounts = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (incentiveClaimed[epoch][gauge][token][msg.sender]) continue;
            incentiveClaimed[epoch][gauge][token][msg.sender] = true;

            uint256 amount = incentives[epoch][gauge][token] * weight / total;
            if (amount == 0) continue;
            amounts[i] = amount;
            IERC20(token).safeTransfer(msg.sender, amount);
            emit IncentiveClaimed(epoch, gauge, token, msg.sender, amount);
        }
    }

    /// @notice What `voter` can claim from a finished week
    function claimable(uint256 epoch, address gauge, address token, address voter) external view returns (uint256) {
        if (epoch >= Epoch.current() || incentiveClaimed[epoch][gauge][token][voter]) return 0;
        uint256 total = gaugeVotes[epoch][gauge];
        if (total == 0) return 0;
        return incentives[epoch][gauge][token] * votes[epoch][voter][gauge] / total;
    }

    /// @notice An incentive paid into a week in which nobody voted for the gauge waits for this week
    function rolloverIncentive(uint256 epoch, address gauge, address token) external nonReentrant {
        if (epoch >= Epoch.current()) revert EpochNotOver();
        if (gaugeVotes[epoch][gauge] != 0) revert AlreadyDone();
        uint256 amount = incentives[epoch][gauge][token];
        if (amount == 0) revert NothingToClaim();

        incentives[epoch][gauge][token] = 0;
        incentives[Epoch.current()][gauge][token] += amount;
        emit IncentiveRolledOver(epoch, gauge, token, amount);
    }

    // ----------------------------------------------------------------------------- governance

    function setMinter(address minter_) external restricted {
        if (minter != address(0)) revert MinterAlreadySet();
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
        emit MinterSet(minter_);
    }

    function setTreasury(address treasury_) external restricted {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }
}
