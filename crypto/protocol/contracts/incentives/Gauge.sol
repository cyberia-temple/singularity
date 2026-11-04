// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title A farm: stake LP shares, earn ASH and whatever else the pool's project adds
/// @notice Each gauge pays out a week-long stream of every reward it holds, pro rata to stake.
///  - **ASH** arrives from the `Voter`, in proportion to the votes the gauge drew last week.
///  - **Anything else** -- typically the launched token itself -- can be streamed by the gauge's
///    manager (the token's creator for a launch farm), up to `MAX_REWARDS` tokens in all. A project
///    can pay its own liquidity providers without asking anyone.
///
/// @dev Synthetix's StakingRewards, per reward token. Rewards that would have accrued while nothing
/// was staked are not lost: they are set aside and added to the next stream of the same token.
contract Gauge is Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant DURATION = 7 days;
    uint256 public constant MAX_REWARDS = 5;
    uint256 internal constant PRECISION = 1e18;

    /// @notice The voter that clones gauges and pays them ASH
    address public immutable voter;

    IERC20 public stakingToken;
    /// @notice The voter's reward; always `rewardTokens[0]`
    address public ash;
    /// @notice May stream other reward tokens
    address public manager;

    struct Reward {
        uint256 rewardRate;
        uint256 rewardPerTokenStored;
        uint64 periodFinish;
        uint64 lastUpdateTime;
        /// @dev accrued while nothing was staked, carried into the next stream
        uint256 idle;
    }

    address[] public rewardTokens;
    mapping(address token => bool) public isReward;
    mapping(address token => Reward) public rewardData;
    mapping(address user => mapping(address token => uint256)) public userRewardPerTokenPaid;
    mapping(address user => mapping(address token => uint256)) public rewards;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed from, address indexed to, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);
    event RewardAdded(address indexed token, uint256 amount, uint256 rewardRate);
    event RewardPaid(address indexed user, address indexed token, uint256 amount);
    event ManagerSet(address indexed manager);

    error NotVoter();
    error NotManager();
    error ZeroAmount();
    error TooManyRewards();
    error RewardTooHigh();

    constructor() {
        voter = msg.sender;
        _disableInitializers();
    }

    function initialize(IERC20 stakingToken_, address ash_, address manager_) external initializer {
        if (msg.sender != voter) revert NotVoter();
        stakingToken = stakingToken_;
        ash = ash_;
        manager = manager_;
        rewardTokens.push(ash_);
        isReward[ash_] = true;
    }

    // ---------------------------------------------------------------------------------- views

    function rewardTokensLength() external view returns (uint256) {
        return rewardTokens.length;
    }

    function lastTimeRewardApplicable(address token) public view returns (uint256) {
        uint256 finish = rewardData[token].periodFinish;
        return block.timestamp < finish ? block.timestamp : finish;
    }

    function rewardPerToken(address token) public view returns (uint256) {
        Reward memory r = rewardData[token];
        if (totalSupply == 0) return r.rewardPerTokenStored;
        return r.rewardPerTokenStored
            + (lastTimeRewardApplicable(token) - r.lastUpdateTime) * r.rewardRate * PRECISION / totalSupply;
    }

    function earned(address account, address token) public view returns (uint256) {
        return balanceOf[account] * (rewardPerToken(token) - userRewardPerTokenPaid[account][token]) / PRECISION
            + rewards[account][token];
    }

    /// @notice What is still to be streamed of `token`
    function left(address token) external view returns (uint256) {
        Reward memory r = rewardData[token];
        if (block.timestamp >= r.periodFinish) return r.idle;
        return (r.periodFinish - block.timestamp) * r.rewardRate + r.idle;
    }

    // ------------------------------------------------------------------------------- staking

    function deposit(uint256 amount, address recipient) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateRewards(recipient);

        totalSupply += amount;
        balanceOf[recipient] += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposit(msg.sender, recipient, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateRewards(msg.sender);

        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);

        emit Withdraw(msg.sender, amount);
    }

    /// @notice Pay `account` everything it has earned, in every reward token
    function getReward(address account) external nonReentrant {
        _updateRewards(account);
        uint256 n = rewardTokens.length;
        for (uint256 i = 0; i < n; i++) {
            _pay(account, rewardTokens[i]);
        }
    }

    /// @notice Pay `account` in the listed reward tokens only
    /// @dev The way out if one reward token ever refuses transfers: the rest stay claimable.
    function getRewards(address account, address[] calldata tokens) external nonReentrant {
        _updateRewards(account);
        for (uint256 i = 0; i < tokens.length; i++) {
            if (isReward[tokens[i]]) _pay(account, tokens[i]);
        }
    }

    function _pay(address account, address token) internal {
        uint256 reward = rewards[account][token];
        if (reward > 0) {
            rewards[account][token] = 0;
            IERC20(token).safeTransfer(account, reward);
            emit RewardPaid(account, token, reward);
        }
    }

    // -------------------------------------------------------------------------------- rewards

    /// @notice Stream `amount` of `token` over the next week, on top of what is still streaming
    /// @dev ASH only from the voter; anything else only from the manager, who can add up to
    /// `MAX_REWARDS` tokens in all.
    function notifyRewardAmount(address token, uint256 amount) external nonReentrant {
        if (token == ash) {
            if (msg.sender != voter) revert NotVoter();
        } else {
            if (msg.sender != manager) revert NotManager();
            if (!isReward[token]) {
                if (rewardTokens.length >= MAX_REWARDS) revert TooManyRewards();
                rewardTokens.push(token);
                isReward[token] = true;
            }
        }
        if (amount == 0) revert ZeroAmount();

        _updateRewardPerToken(token);

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;

        Reward storage r = rewardData[token];
        uint256 toStream = received + r.idle;
        r.idle = 0;
        if (block.timestamp < r.periodFinish) toStream += (r.periodFinish - block.timestamp) * r.rewardRate;

        r.rewardRate = toStream / DURATION;
        // A rate the balance cannot pay would leave the last claimers short.
        uint256 staked = token == address(stakingToken) ? totalSupply : 0;
        if (r.rewardRate * DURATION > IERC20(token).balanceOf(address(this)) - staked) revert RewardTooHigh();

        r.lastUpdateTime = uint64(block.timestamp);
        r.periodFinish = uint64(block.timestamp + DURATION);

        emit RewardAdded(token, received, r.rewardRate);
    }

    function setManager(address manager_) external {
        if (msg.sender != manager) revert NotManager();
        manager = manager_;
        emit ManagerSet(manager_);
    }

    // ------------------------------------------------------------------------------ internals

    function _updateRewards(address account) internal {
        uint256 n = rewardTokens.length;
        for (uint256 i = 0; i < n; i++) {
            address token = rewardTokens[i];
            _updateRewardPerToken(token);
            if (account != address(0)) {
                rewards[account][token] = earned(account, token);
                userRewardPerTokenPaid[account][token] = rewardData[token].rewardPerTokenStored;
            }
        }
    }

    function _updateRewardPerToken(address token) internal {
        Reward storage r = rewardData[token];
        uint256 applicable = lastTimeRewardApplicable(token);

        if (totalSupply == 0) {
            // Nobody to pay for this stretch: keep it for the next stream rather than lose it.
            if (applicable > r.lastUpdateTime) r.idle += (applicable - r.lastUpdateTime) * r.rewardRate;
        } else {
            r.rewardPerTokenStored = rewardPerToken(token);
        }
        r.lastUpdateTime = uint64(applicable);
    }
}
