// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IV3PositionManager} from "../interfaces/IV3.sol";

interface IDistributes {
    function distribute() external returns (uint256);
}

/// @title Where launch liquidity lives forever, still paying its fees
/// @notice A V3 position's fees accrue outside the position, so its liquidity can be locked for good
/// and keep paying. This contract takes a launch's position NFT and never lets it go -- there is no
/// way to decrease its liquidity, burn it or transfer it -- while `collect` stays open to anyone and
/// splits what it collects three ways, by shares fixed the moment the position arrived:
///
///  - the **creator** of the launch;
///  - the token's **holders**: the WCYBER side goes to the token, where every holder can claim their
///    part; the token's own side is burned, which is the same as handing it out pro rata and costs
///    no one a claim;
///  - the **protocol**, which takes the remainder, so rounding never comes out of a creator or a
///    holder.
///
/// @dev The shares are the launchpad's to name, so only launchers allowed by governance may hand a
/// position over. What a position was promised is never revisited; governance can change who the
/// protocol's share goes to, not how large it is.
contract LaunchLocker is IERC721Receiver, AccessManaged {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS = 10_000;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    IV3PositionManager public immutable positions;

    /// @notice Where the protocol's share goes
    address public treasury;

    struct Lock {
        address creator;
        uint16 creatorBps;
        uint16 holdersBps;
        /// @dev the launch token, which pays holders their WCYBER and whose own side is burned
        address token;
    }

    mapping(uint256 => Lock) public locks;
    uint256[] public lockedIds;

    /// @notice Contracts allowed to lock a position under terms they name
    mapping(address => bool) public isLauncher;

    event Locked(uint256 indexed tokenId, address indexed creator, address indexed token, uint16 creatorBps, uint16 holdersBps);
    event Collected(
        uint256 indexed tokenId,
        uint256 creatorAmount0,
        uint256 creatorAmount1,
        uint256 holdersAmount0,
        uint256 holdersAmount1,
        uint256 treasuryAmount0,
        uint256 treasuryAmount1
    );
    event CreatorChanged(uint256 indexed tokenId, address indexed from, address indexed to);
    event LauncherSet(address indexed launcher, bool allowed);
    event TreasurySet(address indexed treasury);

    error NotPositionManager();
    error NotLauncher();
    error AlreadyLocked();
    error NotLocked();
    error BadTerms();
    error NotCreator();
    error ZeroAddress();

    constructor(address authority, IV3PositionManager positions_, address treasury_) AccessManaged(authority) {
        if (address(positions_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        positions = positions_;
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Accepts a position for good, under `abi.encode(creator, creatorBps, holdersBps, token)`
    function onERC721Received(address operator, address, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4)
    {
        if (msg.sender != address(positions)) revert NotPositionManager();
        if (!isLauncher[operator]) revert NotLauncher();
        if (locks[tokenId].creator != address(0)) revert AlreadyLocked();

        (address creator, uint16 creatorBps, uint16 holdersBps, address token) =
            abi.decode(data, (address, uint16, uint16, address));
        if (creator == address(0) || token == address(0)) revert ZeroAddress();
        if (uint256(creatorBps) + holdersBps > BPS) revert BadTerms();

        locks[tokenId] = Lock(creator, creatorBps, holdersBps, token);
        lockedIds.push(tokenId);

        emit Locked(tokenId, creator, token, creatorBps, holdersBps);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Collect a locked position's fees and pay everyone their share
    /// @dev Permissionless: a creator should need nobody's key to get paid.
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
        if (lock.creator == address(0)) revert NotLocked();

        (,, address token0, address token1,,,,,,,,) = positions.positions(tokenId);
        (uint256 amount0, uint256 amount1) = positions.collect(
            IV3PositionManager.CollectParams(tokenId, address(this), type(uint128).max, type(uint128).max)
        );

        (creatorAmount0, holdersAmount0, treasuryAmount0) = _split(amount0, lock);
        (creatorAmount1, holdersAmount1, treasuryAmount1) = _split(amount1, lock);

        _pay(token0, lock.creator, creatorAmount0);
        _pay(token1, lock.creator, creatorAmount1);
        _payHolders(token0, lock.token, holdersAmount0);
        _payHolders(token1, lock.token, holdersAmount1);
        _pay(token0, treasury, treasuryAmount0);
        _pay(token1, treasury, treasuryAmount1);

        emit Collected(
            tokenId, creatorAmount0, creatorAmount1, holdersAmount0, holdersAmount1, treasuryAmount0, treasuryAmount1
        );
    }

    /// @notice Hand a position's creator share to someone else; only its current creator may
    function setCreator(uint256 tokenId, address to) external {
        Lock storage lock = locks[tokenId];
        if (lock.creator == address(0)) revert NotLocked();
        if (msg.sender != lock.creator) revert NotCreator();
        if (to == address(0)) revert ZeroAddress();
        emit CreatorChanged(tokenId, lock.creator, to);
        lock.creator = to;
    }

    function lockedCount() external view returns (uint256) {
        return lockedIds.length;
    }

    function setLauncher(address launcher, bool allowed) external restricted {
        if (launcher == address(0)) revert ZeroAddress();
        isLauncher[launcher] = allowed;
        emit LauncherSet(launcher, allowed);
    }

    function setTreasury(address treasury_) external restricted {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _split(uint256 amount, Lock memory lock)
        internal
        pure
        returns (uint256 creatorAmount, uint256 holdersAmount, uint256 treasuryAmount)
    {
        creatorAmount = amount * lock.creatorBps / BPS;
        holdersAmount = amount * lock.holdersBps / BPS;
        treasuryAmount = amount - creatorAmount - holdersAmount;
    }

    function _pay(address token, address to, uint256 amount) internal {
        if (amount > 0) IERC20(token).safeTransfer(to, amount);
    }

    /// @dev Handing a token to its own holders pro rata and burning it are the same thing, and the
    /// second needs no ledger. The other side is real money and goes to the token's dividend.
    function _payHolders(address token, address launchToken, uint256 amount) internal {
        if (amount == 0) return;
        if (token == launchToken) {
            IERC20(token).safeTransfer(BURN, amount);
            return;
        }
        IERC20(token).safeTransfer(launchToken, amount);
        // Allowed to fail: the token counts its own balance, so the next call credits the same money.
        try IDistributes(launchToken).distribute() {} catch {}
    }
}
