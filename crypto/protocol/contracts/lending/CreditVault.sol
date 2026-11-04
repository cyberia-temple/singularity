// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {Id, ILending, MarketParams} from "./interfaces/ILending.sol";
import {MarketParamsLib} from "./MarketParamsLib.sol";
import {LendingViews} from "./LendingViews.sol";
import {MathLib, WAD} from "../libraries/MathLib.sol";

/// @title Lend without choosing a market
/// @notice Deposit one asset -- WCYBER, USDC -- and the vault lends it across lending markets that
/// its curator has approved, never more into any one of them than its cap. The curator chooses the
/// markets and their caps; allocators move money between them; depositors can leave whenever the
/// markets have the cash. It is an ERC-4626 vault, so its shares are an ordinary token too.
///
/// This is where launch credit gets its lenders: a curator can add every new launch's "borrow CYBER
/// against the token" market with a cap sized to the token's locked liquidity, and depositors earn
/// the interest of all of them while carrying none of them beyond its cap.
///
/// @dev MetaMorpho's model, smaller: one ordered queue serves both deposits (filled in order) and
/// withdrawals (drained in order); idle money is tracked, never read from the balance, so a donation
/// buys nothing; the curator's fee is taken as new shares on interest earned.
contract CreditVault is ERC4626Upgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using MathLib for uint256;

    uint256 public constant MAX_QUEUE = 30;
    uint256 public constant MAX_FEE = 0.5e18;

    ILending public immutable lending;

    address public curator;
    mapping(address => bool) public isAllocator;
    address public feeRecipient;
    uint256 public fee;

    /// @notice Markets in the order deposits fill them and withdrawals drain them
    Id[] public queue;
    mapping(Id => MarketParams) public paramsOf;
    mapping(Id => uint256) public cap;

    /// @notice Assets held here, not lent out
    uint256 public idle;

    /// @dev Total assets at the last fee accrual
    uint256 public lastTotalAssets;

    struct Allocation {
        MarketParams params;
        /// @dev what the vault should have supplied to this market afterwards
        uint256 assets;
    }

    event CapSet(Id indexed id, uint256 cap);
    event QueueSet(Id[] queue);
    event Reallocated(Id indexed id, uint256 supplied, uint256 withdrawn);
    event AllocatorSet(address indexed allocator, bool allowed);
    event CuratorSet(address indexed curator);
    event FeeSet(uint256 fee, address recipient);
    event FeeAccrued(uint256 feeShares);

    error NotCurator();
    error NotAllocator();
    error WrongAsset();
    error MarketNotCreated();
    error QueueFull();
    error NotEmpty();
    error BadQueue();
    error FeeTooHigh();
    error NotEnoughLiquidity();
    error UnknownMarket();

    modifier onlyCurator() {
        if (msg.sender != curator) revert NotCurator();
        _;
    }

    modifier onlyAllocator() {
        if (msg.sender != curator && !isAllocator[msg.sender]) revert NotAllocator();
        _;
    }

    constructor(ILending lending_) {
        lending = lending_;
        _disableInitializers();
    }

    function initialize(IERC20 asset_, string calldata name_, string calldata symbol_, address curator_)
        external
        initializer
    {
        __ERC20_init(name_, symbol_);
        __ERC4626_init(asset_);
        curator = curator_;
        feeRecipient = curator_;
        IERC20(asset_).forceApprove(address(lending), type(uint256).max);
        emit CuratorSet(curator_);
    }

    // ---------------------------------------------------------------------------------- views

    /// @notice Idle money plus what every market owes the vault as of now
    function totalAssets() public view override returns (uint256 assets) {
        assets = idle;
        uint256 n = queue.length;
        for (uint256 i = 0; i < n; i++) {
            assets += LendingViews.expectedSupplyAssets(lending, paramsOf[queue[i]], address(this));
        }
    }

    function queueLength() external view returns (uint256) {
        return queue.length;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), _withdrawable());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner), _convertToShares(_withdrawable(), Math.Rounding.Floor));
    }

    // ------------------------------------------------------------------------------- deposits

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        _accrueFee();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        _accrueFee();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        _accrueFee();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        _accrueFee();
        return super.redeem(shares, receiver, owner);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        idle += assets;
        _supplyQueue();
        lastTotalAssets = totalAssets();
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        _withdrawQueue(assets);
        idle -= assets;
        super._withdraw(caller, receiver, owner, assets, shares);
        lastTotalAssets = totalAssets();
    }

    // ---------------------------------------------------------------------------- curation

    /// @notice Allow a market (cap > 0), retune its cap, or stop new money going into it (cap 0)
    function setCap(MarketParams calldata params, uint256 newCap) external onlyCurator {
        if (params.loanToken != asset()) revert WrongAsset();
        Id id = params.id();
        (,,,, uint128 lastUpdate,) = lending.market(id);
        if (lastUpdate == 0) revert MarketNotCreated();

        if (paramsOf[id].loanToken == address(0)) {
            if (queue.length >= MAX_QUEUE) revert QueueFull();
            paramsOf[id] = params;
            queue.push(id);
        }
        cap[id] = newCap;
        emit CapSet(id, newCap);
    }

    /// @notice Drop a market the vault no longer has anything in
    function removeMarket(Id id) external onlyCurator {
        MarketParams memory params = paramsOf[id];
        if (params.loanToken == address(0)) revert UnknownMarket();
        (uint256 shares,,) = lending.position(id, address(this));
        if (shares != 0) revert NotEmpty();

        uint256 n = queue.length;
        for (uint256 i = 0; i < n; i++) {
            if (Id.unwrap(queue[i]) == Id.unwrap(id)) {
                queue[i] = queue[n - 1];
                queue.pop();
                break;
            }
        }
        delete paramsOf[id];
        delete cap[id];
        emit QueueSet(queue);
    }

    /// @notice Reorder the queue; it must hold exactly the markets it holds now
    function setQueue(Id[] calldata newQueue) external onlyCurator {
        uint256 n = queue.length;
        if (newQueue.length != n) revert BadQueue();
        for (uint256 i = 0; i < n; i++) {
            if (paramsOf[newQueue[i]].loanToken == address(0)) revert BadQueue();
            for (uint256 j = 0; j < i; j++) {
                if (Id.unwrap(newQueue[j]) == Id.unwrap(newQueue[i])) revert BadQueue();
            }
        }
        queue = newQueue;
        emit QueueSet(newQueue);
    }

    function setAllocator(address allocator, bool allowed) external onlyCurator {
        isAllocator[allocator] = allowed;
        emit AllocatorSet(allocator, allowed);
    }

    function setCurator(address curator_) external onlyCurator {
        curator = curator_;
        emit CuratorSet(curator_);
    }

    function setFee(uint256 fee_, address recipient) external onlyCurator {
        if (fee_ > MAX_FEE) revert FeeTooHigh();
        _accrueFee();
        fee = fee_;
        feeRecipient = recipient;
        emit FeeSet(fee_, recipient);
    }

    /// @notice Move money between markets: each allocation names what the vault should have in that
    /// market afterwards. Withdrawals happen first; what they free up, and idle money, fund the rest.
    function reallocate(Allocation[] calldata allocations) external onlyAllocator nonReentrant {
        _accrueFee();
        for (uint256 i = 0; i < allocations.length; i++) {
            MarketParams calldata params = allocations[i].params;
            Id id = params.id();
            if (paramsOf[id].loanToken == address(0)) revert UnknownMarket();
            uint256 current = LendingViews.expectedSupplyAssets(lending, params, address(this));
            if (allocations[i].assets < current) {
                (uint256 withdrawn,) = _withdrawFrom(params, current - allocations[i].assets, current);
                emit Reallocated(id, 0, withdrawn);
            }
        }
        for (uint256 i = 0; i < allocations.length; i++) {
            MarketParams calldata params = allocations[i].params;
            Id id = params.id();
            uint256 current = LendingViews.expectedSupplyAssets(lending, params, address(this));
            if (allocations[i].assets > current) {
                uint256 amount = Math.min(allocations[i].assets - current, idle);
                if (current + amount > cap[id]) amount = cap[id] > current ? cap[id] - current : 0;
                if (amount > 0) {
                    idle -= amount;
                    lending.supply(params, amount, 0, address(this), "");
                    emit Reallocated(id, amount, 0);
                }
            }
        }
        lastTotalAssets = totalAssets();
    }

    // ------------------------------------------------------------------------------ internals

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev Interest earned since the last accrual, less nothing else: deposits and withdrawals
    /// re-base `lastTotalAssets` as they happen.
    function _accrueFee() internal {
        uint256 assets = totalAssets();
        if (fee != 0 && assets > lastTotalAssets) {
            uint256 feeAssets = (assets - lastTotalAssets).wMulDown(fee);
            uint256 feeShares =
                Math.mulDiv(feeAssets, totalSupply() + 10 ** _decimalsOffset(), assets - feeAssets + 1, Math.Rounding.Floor);
            if (feeShares > 0) {
                _mint(feeRecipient, feeShares);
                emit FeeAccrued(feeShares);
            }
        }
        lastTotalAssets = assets;
    }

    function _supplyQueue() internal {
        uint256 n = queue.length;
        for (uint256 i = 0; i < n && idle > 0; i++) {
            MarketParams memory params = paramsOf[queue[i]];
            uint256 supplied = LendingViews.expectedSupplyAssets(lending, params, address(this));
            uint256 room = cap[queue[i]] > supplied ? cap[queue[i]] - supplied : 0;
            uint256 amount = Math.min(room, idle);
            if (amount == 0) continue;
            idle -= amount;
            lending.supply(params, amount, 0, address(this), "");
        }
    }

    function _withdrawQueue(uint256 assets) internal {
        if (assets <= idle) return;
        uint256 needed = assets - idle;
        uint256 n = queue.length;
        for (uint256 i = 0; i < n && needed > 0; i++) {
            MarketParams memory params = paramsOf[queue[i]];
            uint256 supplied = LendingViews.expectedSupplyAssets(lending, params, address(this));
            (uint256 withdrawn,) = _withdrawFrom(params, needed, supplied);
            needed -= withdrawn;
        }
        if (needed > 0) revert NotEnoughLiquidity();
    }

    /// @dev Takes up to `wanted` from one market, bounded by what the vault has there and what the
    /// market can pay; the whole position is redeemed by shares so no dust is left behind.
    function _withdrawFrom(MarketParams memory params, uint256 wanted, uint256 supplied)
        internal
        returns (uint256 withdrawn, uint256 shares)
    {
        if (supplied == 0) return (0, 0);
        uint256 available = Math.min(supplied, LendingViews.liquidity(lending, params));
        uint256 amount = Math.min(wanted, available);
        if (amount == 0) return (0, 0);

        if (amount == supplied) {
            (uint256 allShares,,) = lending.position(params.id(), address(this));
            (withdrawn, shares) = lending.withdraw(params, 0, allShares, address(this), address(this));
        } else {
            (withdrawn, shares) = lending.withdraw(params, amount, 0, address(this), address(this));
        }
        idle += withdrawn;
    }

    function _withdrawable() internal view returns (uint256 total) {
        total = idle;
        uint256 n = queue.length;
        for (uint256 i = 0; i < n; i++) {
            MarketParams memory params = paramsOf[queue[i]];
            total += Math.min(
                LendingViews.expectedSupplyAssets(lending, params, address(this)), LendingViews.liquidity(lending, params)
            );
        }
    }

    function decimals() public view override(ERC4626Upgradeable) returns (uint8) {
        return super.decimals();
    }
}
