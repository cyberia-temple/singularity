// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {ERC20VotesUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import {NoncesUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IV3Pool, IWETH9} from "../interfaces/IV3.sol";

/// @title A launched token: fixed supply, votes, and a share of its own trading fees
/// @notice Everything a token launched on Cyberia is born with:
///
///  - **A fixed supply.** All of it is minted once, into the launch pool. There is no owner and no
///    mint function.
///  - **Votes.** Delegate to yourself (or anyone) and the balance counts in the token's DAO. Time is
///    the clock (ERC-6372 `mode=timestamp`): Avalanche L1 blocks arrive when there is something to
///    put in them, so a vote that lasted "50,000 blocks" would last however long the chain was busy.
///  - **A dividend.** The launch's creator may share part of the pool's fee with holders. It arrives
///    here as WCYBER and every holder can claim their part, in proportion to what they held while it
///    arrived, as the coin or wrapped.
///
/// @dev Deployed as a minimal clone per launch; `rewardAsset` and `launchpad` are the
/// implementation's immutables and so the same for every clone.
///
/// The dividend is the standard magnified-per-share ledger: `magnifiedRewardPerShare` grows by
/// `amount · 2^128 / eligibleSupply` per distribution, and a correction is written on every balance
/// change so an account's earnings cannot move under a transfer. Accounts that hold supply on
/// behalf of others -- the pool, the launchpad, the lending book, the LP vault, the burn address --
/// are excluded and do not count towards `eligibleSupply`. An account can only be excluded while
/// it is empty, so an exclusion never has a balance to reassign or a reward to strand.
contract LaunchToken is ERC20VotesUpgradeable, ERC20PermitUpgradeable, ReentrancyGuardTransient {
    using SafeCast for uint256;

    uint256 internal constant MAGNITUDE = 2 ** 128;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @notice What holders are paid in (WCYBER); `claim` unwraps it
    IWETH9 public immutable rewardAsset;

    /// @notice The only contract that may initialize a launch token or exclude accounts in it
    address public immutable launchpad;

    /// @notice The launch pool
    address public pool;

    /// @notice Accounts that neither earn dividends nor count towards `eligibleSupply`
    mapping(address => bool) public excluded;

    /// @notice Supply held by accounts that earn
    uint256 public eligibleSupply;

    uint256 public magnifiedRewardPerShare;
    mapping(address => int256) internal corrections;
    mapping(address => uint256) public withdrawnRewards;

    uint256 public totalRewardsDistributed;
    uint256 public totalRewardsClaimed;

    event RewardsDistributed(uint256 amount, uint256 eligibleSupply);
    event RewardClaimed(address indexed holder, uint256 amount, bool unwrapped);
    event PoolSet(address indexed pool);
    event ExcludedFromRewards(address indexed account);

    error NotLaunchpad();
    error PoolAlreadySet();
    error AlreadyExcluded();
    error NotEmpty();
    error NotOurPool();
    error NothingToClaim();
    error OnlyRewardAsset();
    error NativeTransferFailed();

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _;
    }

    constructor(IWETH9 rewardAsset_, address launchpad_) {
        rewardAsset = rewardAsset_;
        launchpad = launchpad_;
        _disableInitializers();
    }

    /// @param excludedAccounts Contracts that will hold this token on behalf of others from the
    /// start, such as the lending book. The launchpad and the burn address are always excluded.
    function initialize(string calldata name_, string calldata symbol_, uint256 supply, address[] calldata excludedAccounts)
        external
        initializer
        onlyLaunchpad
    {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __ERC20Votes_init();

        _setExcluded(msg.sender);
        _setExcluded(BURN);
        for (uint256 i = 0; i < excludedAccounts.length; i++) {
            if (!excluded[excludedAccounts[i]]) _setExcluded(excludedAccounts[i]);
        }

        _mint(msg.sender, supply);
    }

    // -------------------------------------------------------------------------------- clock

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    // ---------------------------------------------------------------------------- exclusions

    /// @notice Name the launch pool, once, before it holds anything
    function setPool(address pool_) external onlyLaunchpad {
        if (pool != address(0)) revert PoolAlreadySet();
        pool = pool_;
        _setExcluded(pool_);
        emit PoolSet(pool_);
    }

    /// @notice Exclude a contract the launchpad is about to hand this token to (an LP vault)
    function exclude(address account) external onlyLaunchpad {
        if (excluded[account]) revert AlreadyExcluded();
        _setExcluded(account);
    }

    /// @notice Exclude any further pool of this token on the launch pool's factory
    /// @dev Permissionless and narrow: it must be a pool of the same factory holding this token,
    /// and it must still be empty. A pool that earned dividends would hand the holders' share back
    /// to the liquidity it was charged on.
    function excludePool(address pool_) external {
        if (excluded[pool_]) revert AlreadyExcluded();
        IV3Pool candidate = IV3Pool(pool_);
        if (candidate.factory() != IV3Pool(pool).factory()) revert NotOurPool();
        if (candidate.token0() != address(this) && candidate.token1() != address(this)) revert NotOurPool();
        _setExcluded(pool_);
    }

    function _setExcluded(address account) internal {
        if (balanceOf(account) != 0) revert NotEmpty();
        excluded[account] = true;
        emit ExcludedFromRewards(account);
    }

    // ------------------------------------------------------------------------------ dividend

    /// @notice Credit holders with every WCYBER that has arrived since the last call
    /// @dev Reads its own balance rather than an amount, so a plain transfer of WCYBER here is a
    /// gift to every holder and the locker that forwards fees does not have to be believed. What
    /// integer division cannot spread waits for the next round.
    function distribute() public returns (uint256 credited) {
        uint256 owed = totalRewardsDistributed - totalRewardsClaimed;
        uint256 balance = rewardAsset.balanceOf(address(this));
        if (balance <= owed) return 0;

        uint256 supply = eligibleSupply;
        if (supply == 0) return 0;

        uint256 amount = balance - owed;
        uint256 perShare = amount * MAGNITUDE / supply;
        if (perShare == 0) return 0;

        magnifiedRewardPerShare += perShare;
        totalRewardsDistributed += amount;
        credited = amount;

        emit RewardsDistributed(amount, supply);
    }

    /// @notice Everything `account` has ever been credited, claimed or not
    function accumulativeRewardsOf(address account) public view returns (uint256) {
        if (excluded[account]) return 0;
        int256 magnified = (magnifiedRewardPerShare * balanceOf(account)).toInt256() + corrections[account];
        return magnified < 0 ? 0 : uint256(magnified) / MAGNITUDE;
    }

    function withdrawableRewardsOf(address account) public view returns (uint256) {
        uint256 accumulated = accumulativeRewardsOf(account);
        uint256 withdrawn = withdrawnRewards[account];
        return accumulated > withdrawn ? accumulated - withdrawn : 0;
    }

    /// @notice Take your dividend as CYBER
    function claim() external nonReentrant returns (uint256 amount) {
        amount = _prepareClaim(msg.sender);
        rewardAsset.withdraw(amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit RewardClaimed(msg.sender, amount, true);
    }

    /// @notice Take your dividend as WCYBER, for a holder that cannot receive the coin
    function claimWrapped() external nonReentrant returns (uint256 amount) {
        amount = _prepareClaim(msg.sender);
        rewardAsset.transfer(msg.sender, amount);
        emit RewardClaimed(msg.sender, amount, false);
    }

    function _prepareClaim(address holder) internal returns (uint256 amount) {
        distribute();
        amount = withdrawableRewardsOf(holder);

        // Never promise more than is here. The ledger rounds down at every step so this should not
        // bind, but a claim that reverted for want of a wei would strand the holder's whole share.
        uint256 available = rewardAsset.balanceOf(address(this));
        if (amount > available) amount = available;
        if (amount == 0) revert NothingToClaim();

        withdrawnRewards[holder] += amount;
        totalRewardsClaimed += amount;
    }

    /// @dev Only the unwrap in `claim` sends the coin here; anything else would be counted as
    /// nobody's money.
    receive() external payable {
        if (msg.sender != address(rewardAsset)) revert OnlyRewardAsset();
    }

    // ----------------------------------------------------------------------------- transfers

    /// @dev Keeps `eligibleSupply` equal to the balances that earn, and every account's earnings
    /// fixed through its own transfers.
    function _update(address from, address to, uint256 value) internal override(ERC20Upgradeable, ERC20VotesUpgradeable) {
        if (value != 0) {
            int256 magnified = (magnifiedRewardPerShare * value).toInt256();
            if (from != address(0) && !excluded[from]) {
                corrections[from] += magnified;
                eligibleSupply -= value;
            }
            if (to != address(0) && !excluded[to]) {
                corrections[to] -= magnified;
                eligibleSupply += value;
            }
        }
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20PermitUpgradeable, NoncesUpgradeable) returns (uint256) {
        return super.nonces(owner);
    }
}
