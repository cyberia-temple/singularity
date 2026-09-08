// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '@openzeppelin/contracts-v3/token/ERC20/ERC20.sol';
import '@openzeppelin/contracts-v3/math/SafeMath.sol';
import '@openzeppelin/contracts-v3/math/SignedSafeMath.sol';
import '@openzeppelin/contracts-v3/utils/ReentrancyGuard.sol';

import '../pancake-v3-core/interfaces/IPancakeV3Pool.sol';
import '../pancake-v3-periphery/libraries/TransferHelper.sol';
import '../pancake-v3-periphery/interfaces/external/IWETH9.sol';

/// @title A launch token that pays its holders out of its own trading fees
/// @notice Holding it is the whole claim: a share of every swap arrives here as CYBER and each
/// holder can take their part of it at any time, in proportion to what they held while it arrived.
///
/// @dev Why the token and not the locker. The fee stream is collected by `LaunchLocker` from the
/// launch's own position, and a contract cannot pay "the holders" by iterating them -- there is no
/// list, and there never can be one. The only contract that knows every balance is the token, so
/// the token is where the accounting lives: the locker forwards the holders' share here and the
/// accumulator below turns it into a claim per holder that costs nothing to maintain.
///
/// The accumulator is the standard magnified-per-share ledger. `magnifiedRewardPerShare` grows by
/// `amount * 2**128 / eligibleSupply` on every distribution, a correction is written whenever a
/// balance moves so that what a holder has already earned cannot change under a transfer, and what
/// they may withdraw is `accumulative - withdrawn`. Everything is in `rewardAsset` (WCYBER), which
/// `claim` unwraps so what arrives is the coin.
///
/// **`eligibleSupply` is the part that has to be right.** The pool holds most of the supply and
/// must not earn -- paying the pool would send the holders' share straight back into the liquidity
/// it came from -- so the pool, this token's launchpad and the burn address are excluded, and the
/// eligible total tracks every transfer in and out of them. An account can only be excluded while
/// it is empty, which is what keeps that arithmetic answerable: there is never a balance to
/// reassign, and never a pending reward to strand.
contract LaunchToken is ERC20, ReentrancyGuard {
    using SafeMath for uint256;
    using SignedSafeMath for int256;

    /// @dev Scaling for the per-share accumulator, so integer division does not eat small fees.
    uint256 internal constant MAGNITUDE = 2**128;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @notice The asset holders are paid in (WCYBER; `claim` unwraps it to CYBER)
    IWETH9 public immutable rewardAsset;

    /// @notice The contract that launched this token -- the only address that may name its pool
    address public immutable launchpad;

    /// @notice The v3 factory this token's pools belong to
    address public immutable factory;

    /// @notice The launch pool. Excluded from rewards: it holds the liquidity, not a holder.
    address public pool;

    /// @notice Accounts that neither earn rewards nor count towards `eligibleSupply`
    mapping(address => bool) public excluded;

    /// @notice Supply held by accounts that earn -- the denominator of every distribution
    uint256 public eligibleSupply;

    uint256 public magnifiedRewardPerShare;
    mapping(address => int256) internal corrections;

    /// @notice What each holder has already taken
    mapping(address => uint256) public withdrawnRewards;

    /// @notice Totals, so a distribution can tell new money from money already owed
    uint256 public totalRewardsDistributed;
    uint256 public totalRewardsClaimed;

    event RewardsDistributed(uint256 amount, uint256 eligibleSupply);
    event RewardClaimed(address indexed holder, uint256 amount, bool unwrapped);
    event PoolSet(address indexed pool);
    event ExcludedFromRewards(address indexed account);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address holder_,
        IWETH9 rewardAsset_,
        address factory_
    ) ERC20(name_, symbol_) {
        require(totalSupply_ > 0, 'SUPPLY');
        require(holder_ != address(0) && address(rewardAsset_) != address(0), 'ZERO');
        rewardAsset = rewardAsset_;
        launchpad = msg.sender;
        factory = factory_;

        // The launchpad holds the supply only for the length of the launch transaction, and the
        // burn address holds what is out of circulation forever. Neither is a holder.
        _setExcluded(msg.sender);
        _setExcluded(BURN);

        _mint(holder_, totalSupply_);
    }

    // ------------------------------------------------------------------ exclusions

    /// @notice Name the launch pool, once, before it holds anything
    function setPool(address pool_) external {
        require(msg.sender == launchpad, 'NOT_LAUNCHPAD');
        require(pool == address(0), 'POOL_SET');
        require(pool_ != address(0), 'ZERO');
        pool = pool_;
        _setExcluded(pool_);
        emit PoolSet(pool_);
    }

    /// @notice Exclude a further pool of this token from rewards
    /// @dev Permissionless, and deliberately narrow: the address must be a pool of this factory
    /// holding this token, and it must still be empty. A pool that earned rewards would return the
    /// holders' share to the liquidity it was charged on; an exclusion that had to reassign a
    /// balance is the class of bug this contract cannot afford.
    function excludePool(address pool_) external {
        require(!excluded[pool_], 'ALREADY');
        require(balanceOf(pool_) == 0, 'NOT_EMPTY');
        IPancakeV3Pool candidate = IPancakeV3Pool(pool_);
        require(candidate.factory() == factory, 'NOT_OUR_FACTORY');
        require(
            candidate.token0() == address(this) || candidate.token1() == address(this),
            'NOT_OUR_POOL'
        );
        _setExcluded(pool_);
    }

    function _setExcluded(address account) internal {
        require(balanceOf(account) == 0, 'NOT_EMPTY');
        excluded[account] = true;
        emit ExcludedFromRewards(account);
    }

    // ---------------------------------------------------------------- distribution

    /// @notice Count everything that has arrived since the last time, and credit it to holders
    /// @dev Permissionless and shape-free: it reads this contract's own balance rather than
    /// trusting a caller's number, so a plain transfer of WCYBER to this address is a donation to
    /// every holder, and a locker that forwarded the holders' share does not have to be believed.
    /// The remainder that integer division cannot spread stays here and joins the next round.
    function distribute() public returns (uint256 credited) {
        uint256 owed = totalRewardsDistributed.sub(totalRewardsClaimed);
        uint256 balance = rewardAsset.balanceOf(address(this));
        if (balance <= owed) return 0;
        uint256 amount = balance.sub(owed);
        uint256 supply = eligibleSupply;
        if (supply == 0) return 0;

        uint256 perShare = amount.mul(MAGNITUDE) / supply;
        if (perShare == 0) return 0;

        // The whole amount is booked as owed, not just the part the per-share rate can express.
        // Booking less would leave the difference looking like money nobody had claimed yet, and
        // the next round would hand it out a second time -- which is how a holder ends up with a
        // claim one wei larger than the pot behind it.
        credited = amount;
        magnifiedRewardPerShare = magnifiedRewardPerShare.add(perShare);
        totalRewardsDistributed = totalRewardsDistributed.add(amount);
        emit RewardsDistributed(amount, supply);
    }

    // ---------------------------------------------------------------------- claims

    /// @notice Everything this account has ever been credited, claimed or not
    function accumulativeRewardsOf(address account) public view returns (uint256) {
        if (excluded[account]) return 0;
        int256 magnified = _toInt(magnifiedRewardPerShare.mul(balanceOf(account)))
            .add(corrections[account]);
        return magnified < 0 ? 0 : uint256(magnified) / MAGNITUDE;
    }

    /// @notice What this account can take right now
    function withdrawableRewardsOf(address account) public view returns (uint256) {
        return accumulativeRewardsOf(account).sub(withdrawnRewards[account]);
    }

    /// @notice Take your share, as CYBER
    function claim() external nonReentrant returns (uint256 amount) {
        amount = _prepareClaim(msg.sender);
        rewardAsset.withdraw(amount);
        TransferHelper.safeTransferETH(msg.sender, amount);
        emit RewardClaimed(msg.sender, amount, true);
    }

    /// @notice Take your share as WCYBER -- for a holder that cannot receive the coin
    function claimWrapped() external nonReentrant returns (uint256 amount) {
        amount = _prepareClaim(msg.sender);
        TransferHelper.safeTransfer(address(rewardAsset), msg.sender, amount);
        emit RewardClaimed(msg.sender, amount, false);
    }

    function _prepareClaim(address holder) internal returns (uint256 amount) {
        distribute();
        amount = withdrawableRewardsOf(holder);

        // Never promise more than is here. The per-share ledger rounds down at every step, so this
        // should be unreachable -- but a claim that reverts because the pot is a wei short would
        // strand a holder's whole balance, and only what is actually paid is booked as withdrawn.
        uint256 available = rewardAsset.balanceOf(address(this));
        if (amount > available) amount = available;

        require(amount > 0, 'NOTHING');
        withdrawnRewards[holder] = withdrawnRewards[holder].add(amount);
        totalRewardsClaimed = totalRewardsClaimed.add(amount);
    }

    /// @dev Only the reward asset may send the coin here: this contract's balance is a ledger of
    /// what holders are owed, and a stray transfer would be counted as somebody's reward.
    receive() external payable {
        require(msg.sender == address(rewardAsset), 'ONLY_WCYBER');
    }

    // -------------------------------------------------------------------- transfers

    /// @dev Keeps two things true through every balance movement: `eligibleSupply` is the sum of
    /// the balances that earn, and no holder's already-earned amount changes because they sent or
    /// received tokens.
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override {
        if (amount == 0) return;
        uint256 magnified = magnifiedRewardPerShare.mul(amount);

        if (from != address(0) && !excluded[from]) {
            corrections[from] = corrections[from].add(_toInt(magnified));
            eligibleSupply = eligibleSupply.sub(amount);
        }
        if (to != address(0) && !excluded[to]) {
            corrections[to] = corrections[to].sub(_toInt(magnified));
            eligibleSupply = eligibleSupply.add(amount);
        }
    }

    function _toInt(uint256 value) internal pure returns (int256) {
        require(value <= uint256(type(int256).max), 'INT_OVERFLOW');
        return int256(value);
    }
}
