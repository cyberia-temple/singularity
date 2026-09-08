// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '@openzeppelin/contracts-v3/math/SafeMath.sol';

import '../pancake-v3-core/interfaces/IPancakeV3Factory.sol';
import '../pancake-v3-core/interfaces/IPancakeV3Pool.sol';
import '../pancake-v3-core/libraries/FullMath.sol';
import '../pancake-v3-core/libraries/TickMath.sol';
import '../pancake-v3-periphery/interfaces/INonfungiblePositionManager.sol';
import '../pancake-v3-periphery/interfaces/external/IWETH9.sol';
import '../pancake-v3-periphery/libraries/TransferHelper.sol';

import './LaunchToken.sol';

/// @title Fair launch on Cyberia V3, with the fee named by the person launching
/// @notice One transaction mints a token, pairs its entire supply with the CYBER sent along, locks
/// that position forever and hands its fee stream back: to the creator, to the token's holders, and
/// 1% to the protocol.
///
/// @dev **What the creator chooses.** A v2 launch charges what the DEX charges and burns the LP, so
/// the creator earns nothing and has nothing to decide. Here they name two numbers:
///
///  - `creatorFee` -- up to `MAX_CREATOR_FEE` (10%). Traders pay that plus the protocol's 1%, so
///    the pool charges `creatorFee + PROTOCOL_FEE` and never more than 11%.
///  - `holdersShareBps` -- how much of *their own* fee goes to everyone holding the token. It comes
///    out of the creator's share and never out of the protocol's, so a generous launch and a greedy
///    one cost a trader exactly the same.
///
/// **How an arbitrary fee is possible at all.** A v3 fee is a whitelisted tier, and "3.7%" is not on
/// any whitelist. So every launch pool is created in one canonical tier (`LAUNCH_TIER`, 11%) and its
/// real fee is set once, downward, through `setPoolFeeByCreator` -- a right the factory grants to
/// whoever created a pool, exactly once, before it holds anything. The tier stays the pool's
/// identity (its address, its path encoding, `getPool`); `pool.fee()` is what it charges.
///
/// **Who is paid, and out of what.** The position never leaves `LaunchLocker`, so the liquidity is
/// permanent, but v3 accrues fees outside the position, so the stream is still claimable. The
/// locker splits every collection three ways by the basis points computed here: the protocol's 1%
/// of volume, the holders' share, the creator's remainder. Rounding lands on the protocol.
///
/// Nothing here is upgradeable and nothing here can take the liquidity back out.
contract LaunchpadV3 {
    using SafeMath for uint256;

    uint16 internal constant BPS = 10000;

    /// @notice What the protocol takes on every launch pool, in hundredths of a bip (1%)
    uint24 public constant PROTOCOL_FEE = 10000;

    /// @notice The most a creator may charge on top of it (10%)
    uint24 public constant MAX_CREATOR_FEE = 100000;

    /// @notice The tier every launch pool is created in, and therefore the most one can charge
    uint24 public constant LAUNCH_TIER = PROTOCOL_FEE + MAX_CREATOR_FEE;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPancakeV3Factory public immutable factory;
    INonfungiblePositionManager public immutable positions;
    IWETH9 public immutable wcyber;

    /// @notice Where every launch position goes, forever
    address public immutable locker;

    /// @notice The least CYBER a launch may be paired with
    uint256 public immutable minLiquidity;

    address public owner;

    address[] public allTokens;
    /// @notice The v3 pool of every launched token
    mapping(address => address) public poolOf;

    /// @dev Same fields, in the same order, as the v2 launchpad's own event -- an indexer that
    /// already reads launches keeps reading them, and the terms arrive beside it in `LaunchTerms`.
    event TokenLaunched(
        address indexed token,
        address indexed creator,
        address pool,
        string name,
        string symbol,
        uint256 tokenSupply,
        uint256 cyberLiquidity
    );
    /// @notice What this launch promised, as numbers: what a trade costs and where the fee goes
    event LaunchTerms(
        address indexed token,
        uint256 positionId,
        uint24 poolFee,
        uint16 creatorBps,
        uint16 holdersBps,
        uint16 treasuryBps
    );
    event OwnerChanged(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, 'NOT_OWNER');
        _;
    }

    constructor(
        IPancakeV3Factory factory_,
        INonfungiblePositionManager positions_,
        IWETH9 wcyber_,
        address locker_,
        uint256 minLiquidity_
    ) {
        require(
            address(factory_) != address(0) &&
                address(positions_) != address(0) &&
                address(wcyber_) != address(0) &&
                locker_ != address(0),
            'ZERO'
        );
        factory = factory_;
        positions = positions_;
        wcyber = wcyber_;
        locker = locker_;
        minLiquidity = minLiquidity_;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice What a launch at this fee would mean, before launching one
    /// @dev The same arithmetic the launch itself uses, exposed so a screen can print the promise
    /// rather than restate it: what a trader pays, and how one unit of collected fees is split.
    function quote(uint24 creatorFee, uint16 holdersShareBps)
        public
        pure
        returns (
            uint24 poolFee,
            uint16 creatorBps,
            uint16 holdersBps,
            uint16 treasuryBps
        )
    {
        require(creatorFee <= MAX_CREATOR_FEE, 'FEE');
        require(holdersShareBps <= BPS, 'SHARE');
        poolFee = creatorFee + PROTOCOL_FEE;

        // The creator's side of one unit of collected fees, then the holders' cut of that. Floors
        // everywhere, so the treasury's remainder is never short of the protocol's 1%.
        uint16 creatorSide = uint16((uint256(BPS) * creatorFee) / poolFee);
        holdersBps = uint16((uint256(creatorSide) * holdersShareBps) / BPS);
        creatorBps = creatorSide - holdersBps;
        treasuryBps = BPS - creatorSide;
    }

    /// @dev The launch's own numbers, in memory rather than on the stack: a launch has more
    /// moving parts than the EVM has reachable stack slots.
    struct LaunchVars {
        address token;
        address pool;
        address token0;
        address token1;
        uint256 amount0;
        uint256 amount1;
        uint256 positionId;
        uint24 poolFee;
        uint16 creatorBps;
        uint16 holdersBps;
    }

    /// @notice Launch a token: all of its supply against the CYBER sent, locked forever
    /// @param name_ Token name
    /// @param symbol_ Token symbol
    /// @param totalSupply_ Full supply, all of it paired into the pool
    /// @param creatorFee What the creator charges, in hundredths of a bip (10000 = 1%), max 10%
    /// @param holdersShareBps How much of the creator's own fee goes to holders (10000 = all of it)
    function launch(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        uint24 creatorFee,
        uint16 holdersShareBps
    )
        external
        payable
        returns (
            address token,
            address pool,
            uint256 positionId
        )
    {
        require(bytes(name_).length > 0 && bytes(symbol_).length > 0, 'META');
        require(totalSupply_ > 0, 'SUPPLY');
        require(msg.value >= minLiquidity, 'CYBER<MIN');

        LaunchVars memory v;
        (v.poolFee, v.creatorBps, v.holdersBps, ) = quote(creatorFee, holdersShareBps);

        LaunchToken launched = new LaunchToken(
            name_,
            symbol_,
            totalSupply_,
            address(this),
            wcyber,
            address(factory)
        );
        v.token = address(launched);
        allTokens.push(v.token);

        wcyber.deposit{value: msg.value}();

        // The pool is ours to create, which is what makes the fee ours to set once.
        v.pool = factory.createPool(v.token, address(wcyber), LAUNCH_TIER);
        poolOf[v.token] = v.pool;

        (v.token0, v.token1) = v.token < address(wcyber)
            ? (v.token, address(wcyber))
            : (address(wcyber), v.token);
        (v.amount0, v.amount1) = v.token0 == v.token
            ? (totalSupply_, msg.value)
            : (msg.value, totalSupply_);

        // Price the pool at exactly the ratio being deposited, then take the one fee adjustment.
        IPancakeV3Pool(v.pool).initialize(_sqrtPriceX96(v.amount0, v.amount1));
        if (v.poolFee < LAUNCH_TIER) factory.setPoolFeeByCreator(v.pool, v.poolFee);

        // Excluded from rewards while it is still empty: the pool holds liquidity, not a holder.
        launched.setPool(v.pool);

        v.positionId = _mintFullRange(v.token0, v.token1, v.amount0, v.amount1);

        // Locked forever, under terms the locker records and this contract cannot revisit.
        positions.safeTransferFrom(
            address(this),
            locker,
            v.positionId,
            abi.encode(msg.sender, v.creatorBps, v.holdersBps, v.token)
        );

        _refundDust(v.token, msg.sender);
        _announce(v, name_, symbol_, totalSupply_);

        return (v.token, v.pool, v.positionId);
    }

    /// @dev Both events from a frame of their own: the launch that produced them has no stack left.
    function _announce(
        LaunchVars memory v,
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_
    ) private {
        emit TokenLaunched(v.token, msg.sender, v.pool, name_, symbol_, totalSupply_, msg.value);
        emit LaunchTerms(
            v.token,
            v.positionId,
            v.poolFee,
            v.creatorBps,
            v.holdersBps,
            BPS - v.creatorBps - v.holdersBps
        );
    }

    /// @dev One position covering every price, so the pool can never run out of range and strand a
    /// launch. Ticks are snapped inward to the tier's spacing, which is what the pool accepts.
    function _mintFullRange(
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    ) internal returns (uint256 positionId) {
        int24 spacing = factory.feeAmountTickSpacing(LAUNCH_TIER);
        require(spacing > 0, 'NO_TIER');
        int24 lower = (TickMath.MIN_TICK / spacing) * spacing;
        int24 upper = (TickMath.MAX_TICK / spacing) * spacing;
        if (lower < TickMath.MIN_TICK) lower += spacing;
        if (upper > TickMath.MAX_TICK) upper -= spacing;

        TransferHelper.safeApprove(token0, address(positions), amount0);
        TransferHelper.safeApprove(token1, address(positions), amount1);

        (positionId, , , ) = positions.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: LAUNCH_TIER,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        // An allowance this contract does not need is an allowance somebody else could use.
        TransferHelper.safeApprove(token0, address(positions), 0);
        TransferHelper.safeApprove(token1, address(positions), 0);
    }

    /// @dev A full-range mint takes almost, but not exactly, both amounts. What is left is a few
    /// wei: the token's goes out of circulation, the CYBER goes back to whoever launched.
    function _refundDust(address token, address creator) internal {
        uint256 tokenDust = LaunchToken(payable(token)).balanceOf(address(this));
        if (tokenDust > 0) TransferHelper.safeTransfer(token, BURN, tokenDust);

        uint256 wrappedDust = wcyber.balanceOf(address(this));
        if (wrappedDust > 0) {
            wcyber.withdraw(wrappedDust);
            TransferHelper.safeTransferETH(creator, wrappedDust);
        }
    }

    /// @dev sqrt(amount1 / amount0) in Q64.96 -- the price the pool opens at.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(amount1, uint256(1) << 192, amount0);
        uint256 root = _sqrt(ratioX192);
        require(root >= TickMath.MIN_SQRT_RATIO && root < TickMath.MAX_SQRT_RATIO, 'PRICE');
        return uint160(root);
    }

    /// @dev Babylonian square root, seeded by bit length so it converges in a handful of steps.
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 xx = x;
        uint256 r = 1;
        if (xx >= 0x100000000000000000000000000000000) {
            xx >>= 128;
            r <<= 64;
        }
        if (xx >= 0x10000000000000000) {
            xx >>= 64;
            r <<= 32;
        }
        if (xx >= 0x100000000) {
            xx >>= 32;
            r <<= 16;
        }
        if (xx >= 0x10000) {
            xx >>= 16;
            r <<= 8;
        }
        if (xx >= 0x100) {
            xx >>= 8;
            r <<= 4;
        }
        if (xx >= 0x10) {
            xx >>= 4;
            r <<= 2;
        }
        if (xx >= 0x4) {
            r <<= 1;
        }
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        uint256 r1 = x / r;
        return r < r1 ? r : r1;
    }

    /// @dev Required to receive the position NFT before it is passed on to the locker.
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @dev Unwrapping the dust sends the coin here on its way back to the creator.
    receive() external payable {
        require(msg.sender == address(wcyber), 'ONLY_WCYBER');
    }

    function setOwner(address to) external onlyOwner {
        require(to != address(0), 'ZERO');
        emit OwnerChanged(owner, to);
        owner = to;
    }
}
