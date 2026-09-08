// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '@openzeppelin/contracts-v3/token/ERC721/IERC721Receiver.sol';

import '../pancake-v3-core/libraries/TransferHelper.sol';
import './interfaces/ILaunchRewards.sol';
import '../pancake-v3-periphery/interfaces/INonfungiblePositionManager.sol';
import '../pancake-v3-periphery/libraries/PositionValue.sol';

/// @title Permanent home for a launch's liquidity position, with its fees still payable
/// @notice A v2 launch burns its LP token, and the fees that LP would have earned are lost with it,
/// because in v2 fees compound into the reserves a burned LP can no longer redeem. In v3 fees accrue
/// *outside* the position and are claimed separately, so liquidity can be locked forever and still
/// pay out. This contract is that: it takes a position NFT and never lets it leave -- there is no
/// `decreaseLiquidity` here, no `burn`, and no way to transfer the NFT out -- while `collect` stays
/// open to anyone and splits what it collects between the launch's creator and the treasury.
///
/// The split is three-way, because a launch here promises three different people something: the
/// creator's own fee, the holders' share of it, and the protocol's 1%. All three are shares of the
/// same collected amount, so they are stored as basis points of it and the treasury takes the
/// remainder -- rounding lands on the protocol, never on a creator or a holder.
///
/// The holders' share is paid two ways, and the difference is arithmetic rather than policy. On the
/// **quote** side (CYBER) it is forwarded to the launch token, which credits every holder in
/// proportion to what they hold; on the **token's own** side it is burned, because handing a token
/// pro-rata to its own holders and destroying it are the same operation -- everyone's fraction of
/// the supply rises identically -- and one of them costs no claim and no gas.
///
/// @dev The split is snapshotted when the position arrives and is never touched again. The owner can
/// retune `defaultCreatorBps` for future launches as often as they like; what an existing launch was
/// promised is not the owner's to change. A creator fee that can be revoked is not a reason to launch
/// here, and a promise that cannot be checked in the contract is not a promise.
contract LaunchLocker is IERC721Receiver {
    uint16 internal constant BPS = 10000;

    /// @dev Where the holders' share of the launch token's own side goes; see `_payHolders`.
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    INonfungiblePositionManager public immutable positions;

    address public owner;

    /// @notice Where the non-creator share of collected fees goes
    address public treasury;

    /// @notice The creator's share applied to positions locked from now on, in basis points
    uint16 public defaultCreatorBps;

    struct Lock {
        // who receives the creator share of this position's fees
        address creator;
        // the creator's share, fixed at the moment this position was locked
        uint16 creatorBps;
        // the holders' share, likewise fixed; zero for a launch that shares nothing
        uint16 holdersBps;
        // the token that pays its holders (`ILaunchRewards`), and whose own side of the fees is
        // burned instead of distributed. Zero when nobody promised holders anything.
        address rewardsTo;
        // set once the position is here, so tokenId 0 and an unknown tokenId read differently
        bool locked;
    }

    /// @notice The terms each locked position was accepted under
    mapping(uint256 => Lock) public locks;

    /// @notice Every position this contract holds, in the order they arrived
    uint256[] public lockedIds;

    /// @notice Contracts allowed to name a split when they hand a position over
    /// @dev A launchpad computes the split from the fee its creator chose, so it has to be able to
    /// say it. Everyone else gets `defaultCreatorBps` and no holder share, exactly as before -- an
    /// arbitrary sender naming its own terms is how a position ends up promising the treasury
    /// nothing.
    mapping(address => bool) public launchers;

    event Locked(
        uint256 indexed tokenId,
        address indexed creator,
        uint16 creatorBps,
        uint16 holdersBps,
        address rewardsTo
    );
    event Collected(
        uint256 indexed tokenId,
        address indexed creator,
        uint256 creatorAmount0,
        uint256 creatorAmount1,
        uint256 holdersAmount0,
        uint256 holdersAmount1,
        uint256 treasuryAmount0,
        uint256 treasuryAmount1
    );
    event LauncherChanged(address indexed launcher, bool allowed);
    event CreatorChanged(uint256 indexed tokenId, address indexed from, address indexed to);
    event DefaultCreatorBpsChanged(uint16 from, uint16 to);
    event TreasuryChanged(address indexed from, address indexed to);
    event OwnerChanged(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, 'NOT_OWNER');
        _;
    }

    constructor(
        INonfungiblePositionManager _positions,
        address _treasury,
        uint16 _defaultCreatorBps
    ) {
        require(_treasury != address(0), 'TREASURY');
        require(_defaultCreatorBps <= BPS, 'BPS');
        positions = _positions;
        treasury = _treasury;
        defaultCreatorBps = _defaultCreatorBps;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
        emit TreasuryChanged(address(0), _treasury);
        emit DefaultCreatorBpsChanged(0, _defaultCreatorBps);
    }

    /// @notice Accepts a position NFT and locks it permanently
    /// @dev `data` says who the fees belong to, in one of two shapes:
    ///
    ///  - 32 bytes, `(address creator)` -- anyone. The creator gets `defaultCreatorBps`, holders
    ///    get nothing, the treasury gets the rest.
    ///  - 128 bytes, `(address creator, uint16 creatorBps, uint16 holdersBps, address rewardsTo)`
    ///    -- an allowlisted launcher only, because it is naming the treasury's own share.
    ///
    /// Anything else is refused rather than defaulted: a position locked to nobody would pay its
    /// whole fee stream to the treasury forever, silently, and there would be no way back because
    /// the NFT can never leave.
    function onERC721Received(
        address operator,
        address,
        uint256 tokenId,
        bytes calldata data
    ) external override returns (bytes4) {
        require(msg.sender == address(positions), 'NOT_POSITION');
        require(!locks[tokenId].locked, 'LOCKED');

        address creator;
        uint16 creatorBps;
        uint16 holdersBps;
        address rewardsTo;

        if (data.length == 128) {
            require(launchers[operator], 'NOT_LAUNCHER');
            (creator, creatorBps, holdersBps, rewardsTo) = abi.decode(
                data,
                (address, uint16, uint16, address)
            );
            require(uint256(creatorBps) + uint256(holdersBps) <= BPS, 'BPS');
            require(holdersBps == 0 || rewardsTo != address(0), 'NO_REWARDS_TO');
        } else {
            require(data.length == 32, 'NO_CREATOR');
            creator = abi.decode(data, (address));
            creatorBps = defaultCreatorBps;
        }
        require(creator != address(0), 'NO_CREATOR');

        locks[tokenId] = Lock({
            creator: creator,
            creatorBps: creatorBps,
            holdersBps: holdersBps,
            rewardsTo: rewardsTo,
            locked: true
        });
        lockedIds.push(tokenId);

        emit Locked(tokenId, creator, creatorBps, holdersBps, rewardsTo);
        return this.onERC721Received.selector;
    }

    /// @notice Collects a locked position's accrued fees and pays them out
    /// @dev Permissionless on purpose: the creator should not need this contract's operator, or any
    /// key at all, to be paid. Nothing accumulates here -- collecting and splitting is one call.
    function collect(uint256 tokenId)
        external
        returns (
            uint256 creatorAmount0,
            uint256 creatorAmount1,
            uint256 holdersAmount0,
            uint256 holdersAmount1,
            uint256 treasuryAmount0,
            uint256 treasuryAmount1
        )
    {
        Lock memory lock = locks[tokenId];
        require(lock.locked, 'NOT_LOCKED');

        (, , address token0, address token1, , , , , , , , ) = positions.positions(tokenId);

        (uint256 amount0, uint256 amount1) = positions.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        (creatorAmount0, holdersAmount0, treasuryAmount0) = _split(amount0, lock);
        (creatorAmount1, holdersAmount1, treasuryAmount1) = _split(amount1, lock);

        address _treasury = treasury;
        if (creatorAmount0 > 0) TransferHelper.safeTransfer(token0, lock.creator, creatorAmount0);
        if (creatorAmount1 > 0) TransferHelper.safeTransfer(token1, lock.creator, creatorAmount1);
        if (holdersAmount0 > 0) _payHolders(token0, lock.rewardsTo, holdersAmount0);
        if (holdersAmount1 > 0) _payHolders(token1, lock.rewardsTo, holdersAmount1);
        if (treasuryAmount0 > 0) TransferHelper.safeTransfer(token0, _treasury, treasuryAmount0);
        if (treasuryAmount1 > 0) TransferHelper.safeTransfer(token1, _treasury, treasuryAmount1);

        emit Collected(
            tokenId,
            lock.creator,
            creatorAmount0,
            creatorAmount1,
            holdersAmount0,
            holdersAmount1,
            treasuryAmount0,
            treasuryAmount1
        );
    }

    /// @notice What `collect` would pay out right now, before it is called
    function claimable(uint256 tokenId)
        external
        view
        returns (
            uint256 creatorAmount0,
            uint256 creatorAmount1,
            uint256 holdersAmount0,
            uint256 holdersAmount1,
            uint256 treasuryAmount0,
            uint256 treasuryAmount1
        )
    {
        Lock memory lock = locks[tokenId];
        require(lock.locked, 'NOT_LOCKED');

        (uint256 amount0, uint256 amount1) = PositionValue.fees(positions, tokenId);
        (creatorAmount0, holdersAmount0, treasuryAmount0) = _split(amount0, lock);
        (creatorAmount1, holdersAmount1, treasuryAmount1) = _split(amount1, lock);
    }

    /// @dev One arithmetic for the payout and for the preview, so they can never disagree. Amounts
    /// are bounded by uint128 (the position manager's own type), so the multiplications cannot
    /// overflow, and the treasury takes the remainder: rounding is never taken from a creator or a
    /// holder, and the three parts always add up to exactly what was collected.
    function _split(uint256 amount, Lock memory lock)
        internal
        pure
        returns (
            uint256 creatorAmount,
            uint256 holdersAmount,
            uint256 treasuryAmount
        )
    {
        creatorAmount = (amount * lock.creatorBps) / BPS;
        holdersAmount = (amount * lock.holdersBps) / BPS;
        treasuryAmount = amount - creatorAmount - holdersAmount;
    }

    /// @dev The holders' share of one side of the fees.
    ///
    /// Giving a token to its own holders in proportion to what they hold is the same as destroying
    /// it -- every holder's fraction of the supply rises by the same factor -- so the token's own
    /// side is burned, which needs no ledger and no claim. The other side is real money and goes to
    /// the token's reward accumulator, where each holder can withdraw their part of it.
    ///
    /// The nudge is allowed to fail. `distribute()` reads the token's own balance rather than
    /// trusting an amount, so a token that reverts here has still been paid, and the next call --
    /// by anyone, including a holder claiming -- counts the same money.
    function _payHolders(
        address token,
        address rewardsTo,
        uint256 amount
    ) internal {
        if (token == rewardsTo) {
            TransferHelper.safeTransfer(token, BURN, amount);
            return;
        }
        TransferHelper.safeTransfer(token, rewardsTo, amount);
        try ILaunchRewards(rewardsTo).distribute() {} catch {}
    }

    /// @notice How many positions are locked here
    function lockedCount() external view returns (uint256) {
        return lockedIds.length;
    }

    /// @notice Hands this position's fee stream to somebody else
    /// @dev Only the current creator. A project that changes hands should not need our permission,
    /// and we should not be able to redirect their fees without them.
    function setCreator(uint256 tokenId, address to) external {
        Lock storage lock = locks[tokenId];
        require(lock.locked, 'NOT_LOCKED');
        require(msg.sender == lock.creator, 'NOT_CREATOR');
        require(to != address(0), 'ZERO');
        emit CreatorChanged(tokenId, lock.creator, to);
        lock.creator = to;
    }

    /// @notice Sets the creator share for positions locked from now on
    /// @dev Existing locks keep the share they were accepted under; see the note on this contract.
    function setDefaultCreatorBps(uint16 bps) external onlyOwner {
        require(bps <= BPS, 'BPS');
        emit DefaultCreatorBpsChanged(defaultCreatorBps, bps);
        defaultCreatorBps = bps;
    }

    /// @notice Allow (or stop allowing) a contract to name the split it locks a position under
    /// @dev The launchpad is the only intended entry. It is a switch and not a snapshot on purpose:
    /// removing a launcher cannot change any split it has already locked in.
    function setLauncher(address launcher, bool allowed) external onlyOwner {
        require(launcher != address(0), 'ZERO');
        launchers[launcher] = allowed;
        emit LauncherChanged(launcher, allowed);
    }

    function setTreasury(address to) external onlyOwner {
        require(to != address(0), 'ZERO');
        emit TreasuryChanged(treasury, to);
        treasury = to;
    }

    function setOwner(address to) external onlyOwner {
        emit OwnerChanged(owner, to);
        owner = to;
    }
}
