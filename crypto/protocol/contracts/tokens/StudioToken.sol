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

/// @title A token made in the studio: the launch token's economy, with the supply its creator chose
/// @notice What `TokenStudio.create` makes. Everything a launched token has -- votes on a timestamp
/// clock, a dividend of its own pool's fees in WCYBER, a pool whose liquidity is locked for good --
/// and what a launch token deliberately lacks:
///
///  - **A minter, if the creator wants one.** `minter` may mint to any address, up to `maxSupply`,
///    and can hand the right to someone else -- the token's own DAO timelock, say -- or give it up
///    for good with `setMinter(address(0))`. A token created without a minter is fixed from its
///    first block, exactly like a launch token.
///  - **Burning.** Any holder can burn what they hold, or what they were allowed to spend.
///
/// @dev Deployed as a minimal clone per creation. `rewardAsset` is the implementation's immutable;
/// the studio is whoever initialized the clone, which `TokenStudio` does in the transaction that
/// creates it.
///
/// The dividend is LaunchToken's magnified-per-share ledger, line for line, with one difference a
/// growing supply needs: it waits until a whole token is eligible before it credits anything. With
/// supply bounded by `MAX_SUPPLY` that keeps `magnifiedRewardPerShare × balance` inside an int256 for
/// any amount of CYBER that can exist, however much is minted after a distribution.
contract StudioToken is ERC20VotesUpgradeable, ERC20PermitUpgradeable, ReentrancyGuardTransient {
    using SafeCast for uint256;

    uint256 internal constant MAGNITUDE = 2 ** 128;

    /// @notice The most of any studio token that can ever exist: a trillion whole tokens
    uint256 public constant MAX_SUPPLY = 1e30;

    /// @notice The least eligible supply a distribution credits
    uint256 public constant MIN_ELIGIBLE_SUPPLY = 1e18;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @notice What holders are paid in (WCYBER); `claim` unwraps it
    IWETH9 public immutable rewardAsset;

    /// @notice The studio that made this token, the only account that may exclude others in it
    address public studio;

    /// @notice Who may mint; nobody once it is `address(0)`
    address public minter;

    /// @notice The ceiling minting can reach
    uint256 public maxSupply;

    /// @notice The token's pool in the studio
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

    event MinterChanged(address indexed from, address indexed to);
    event RewardsDistributed(uint256 amount, uint256 eligibleSupply);
    event RewardClaimed(address indexed holder, uint256 amount, bool unwrapped);
    event PoolSet(address indexed pool);
    event ExcludedFromRewards(address indexed account);

    error NotStudio();
    error NotMinter();
    error CapExceeded();
    error PoolAlreadySet();
    error AlreadyExcluded();
    error NotEmpty();
    error NotOurPool();
    error NothingToClaim();
    error OnlyRewardAsset();
    error NativeTransferFailed();

    modifier onlyStudio() {
        if (msg.sender != studio) revert NotStudio();
        _;
    }

    constructor(IWETH9 rewardAsset_) {
        rewardAsset = rewardAsset_;
        _disableInitializers();
    }

    /// @param supply Minted to the caller, which hands it on: part into the pool, part to the
    /// addresses the creator named
    /// @param excludedAccounts Contracts that will hold this token on behalf of others from the start
    /// @param minter_ Who may mint more; `address(0)` for a fixed supply
    /// @param maxSupply_ The ceiling minting can reach; zero for `MAX_SUPPLY`
    function initialize(
        string calldata name_,
        string calldata symbol_,
        uint256 supply,
        address[] calldata excludedAccounts,
        address minter_,
        uint256 maxSupply_
    ) external initializer {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __ERC20Votes_init();

        uint256 cap = maxSupply_ == 0 ? MAX_SUPPLY : maxSupply_;
        if (cap > MAX_SUPPLY || supply > cap) revert CapExceeded();
        maxSupply = cap;
        studio = msg.sender;
        minter = minter_;
        emit MinterChanged(address(0), minter_);

        _setExcluded(msg.sender);
        _setExcluded(BURN);
        for (uint256 i = 0; i < excludedAccounts.length; i++) {
            if (!excluded[excludedAccounts[i]]) _setExcluded(excludedAccounts[i]);
        }

        _mint(msg.sender, supply);
    }

    // ------------------------------------------------------------------------------- supply

    /// @notice Whether more of this token can ever be minted
    function mintable() external view returns (bool) {
        return minter != address(0) && totalSupply() < maxSupply;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (totalSupply() + amount > maxSupply) revert CapExceeded();
        _mint(to, amount);
    }

    /// @notice Hand minting to someone else, or to nobody (`address(0)`) to fix the supply for good
    function setMinter(address minter_) external {
        if (msg.sender != minter) revert NotMinter();
        emit MinterChanged(minter, minter_);
        minter = minter_;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
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

    /// @notice Name the token's pool, once, before it holds anything
    function setPool(address pool_) external onlyStudio {
        if (pool != address(0)) revert PoolAlreadySet();
        pool = pool_;
        _setExcluded(pool_);
        emit PoolSet(pool_);
    }

    /// @notice Exclude a contract the studio is about to hand this token to (an LP vault)
    function exclude(address account) external onlyStudio {
        if (excluded[account]) revert AlreadyExcluded();
        _setExcluded(account);
    }

    /// @notice Exclude any further pool of this token on the token pool's factory, while it is empty
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
    /// @dev What arrives while less than a whole token is eligible waits for there to be holders.
    function distribute() public returns (uint256 credited) {
        uint256 owed = totalRewardsDistributed - totalRewardsClaimed;
        uint256 balance = rewardAsset.balanceOf(address(this));
        if (balance <= owed) return 0;

        uint256 supply = eligibleSupply;
        if (supply < MIN_ELIGIBLE_SUPPLY) return 0;

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

        uint256 available = rewardAsset.balanceOf(address(this));
        if (amount > available) amount = available;
        if (amount == 0) revert NothingToClaim();

        withdrawnRewards[holder] += amount;
        totalRewardsClaimed += amount;
    }

    receive() external payable {
        if (msg.sender != address(rewardAsset)) revert OnlyRewardAsset();
    }

    // ----------------------------------------------------------------------------- transfers

    /// @dev Keeps `eligibleSupply` equal to the balances that earn, and every account's earnings
    /// fixed through its own transfers, mints and burns.
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
