// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IV3Factory, IV3Pool, IV3PositionManager, IWETH9} from "../interfaces/IV3.sol";
import {ILending, MarketParams, Id} from "../lending/interfaces/ILending.sol";
import {MarketParamsLib} from "../lending/MarketParamsLib.sol";
import {OracleFactory} from "../oracles/OracleFactory.sol";
import {LiquidityVaultFactory} from "../liquidity/LiquidityVaultFactory.sol";
import {LaunchToken} from "../tokens/LaunchToken.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {LaunchLocker} from "./LaunchLocker.sol";
import {IGaugeRegistry, IZoneRegistry, IDAOFactory, ILaunchRegistry} from "./interfaces/IEconomyModules.sol";

/// @title Launch a token with its whole economy around it
/// @notice One transaction mints a token, pairs its entire supply with the CYBER sent along in a V3
/// pool, locks that liquidity forever, and opens what a token needs to be more than a ticker:
///
///  - **a market** -- the launch pool, its full-range liquidity locked in `LaunchLocker`, its fee
///    named by the creator and shared with the creator, the holders and the protocol;
///  - **liquidity anyone can add** -- a full-range LP vault whose shares are an ordinary token;
///  - **credit** (`KIT_CREDIT`) -- two lending markets priced from the pool's own history: borrow
///    CYBER against the token, and borrow the token against CYBER, which is how holders earn on it
///    and how anyone can bet against it;
///  - **a farm** (`KIT_FARM`) -- a gauge for the LP vault, so ASH voters can direct emissions to it;
///  - **a name zone** (`KIT_ZONE`) -- a token named `.moon` with the ticker `DOTMOON` opens the
///    `.moon` domain zone, whose names are paid for by burning the token;
///  - **a DAO** (`KIT_DAO`) -- a governor and a timelock voted by the token itself.
///
/// Every part of the kit can also be opened later, by anyone, with the matching `open*` call, and
/// `economyOf` returns all of it in one read. Prediction markets and the NFT market take any token
/// as their currency, so a launched token can be bet and paid with from its first block.
///
/// @dev The token's address is a clone address salted with the creator and their own salt, and the
/// DEX factory refuses to create a pool for an address with no code, so nobody can occupy a launch's
/// pool before the launch creates it. The pool is born in the 11% tier and its real fee set once,
/// downward, through the right the factory grants a pool's creator.
contract Launchpad is AccessManaged, IERC721Receiver, ILaunchRegistry {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;

    uint16 internal constant BPS = 10_000;

    /// @notice The protocol's cut of every launch pool's volume, in hundredths of a bip (1%)
    uint24 public constant PROTOCOL_FEE = 10_000;

    /// @notice The most a creator may charge on top of it (10%)
    uint24 public constant MAX_CREATOR_FEE = 100_000;

    /// @notice The tier every launch pool is created in, and so the ceiling on what it can charge
    uint24 public constant LAUNCH_TIER = PROTOCOL_FEE + MAX_CREATOR_FEE;

    /// @notice A supply cap that keeps every launch's opening price inside what a pool can hold
    uint256 public constant MAX_SUPPLY = 1e36;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint8 public constant KIT_CREDIT = 1;
    uint8 public constant KIT_FARM = 2;
    uint8 public constant KIT_ZONE = 4;
    uint8 public constant KIT_DAO = 8;

    IV3Factory public immutable dexFactory;
    IV3PositionManager public immutable positions;
    IWETH9 public immutable wcyber;
    LaunchLocker public immutable locker;
    ILending public immutable lending;
    OracleFactory public immutable oracles;
    LiquidityVaultFactory public immutable vaults;
    address public immutable tokenImplementation;

    // ---------------------------------------------------------------- governed settings

    /// @notice The least CYBER a launch may be paired with
    uint256 public minLiquidity;

    /// @notice Rate model and LLTV of the credit markets a launch opens
    address public creditIrm;
    uint256 public creditLltv;

    /// @notice History the credit markets' oracles average over, and the least they will price with
    uint32 public twapWindow = 30 minutes;
    uint32 public twapMinWindow = 10 minutes;

    /// @notice How many price observations a launch pool keeps (the TWAP's memory)
    uint16 public observationCardinality = 64;

    IGaugeRegistry public gauges;
    IZoneRegistry public zones;
    IDAOFactory public daos;

    // ----------------------------------------------------------------------- the registry

    struct Economy {
        address creator;
        uint64 launchedAt;
        address pool;
        uint256 positionId;
        address vault;
        address gauge;
        address tokenOracle;
        address cyberOracle;
        Id borrowCyberMarket;
        Id borrowTokenMarket;
        address governor;
        address timelock;
        bool zone;
        string metadataURI;
    }

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply;
        /// @dev hundredths of a bip, at most MAX_CREATOR_FEE
        uint24 creatorFee;
        /// @dev how much of the creator's own fee goes to holders, in basis points
        uint16 holdersShareBps;
        /// @dev makes the token's address the creator's to choose among
        bytes32 salt;
        /// @dev KIT_* flags
        uint8 kit;
        string metadataURI;
    }

    mapping(address token => Economy) internal _economies;
    address[] public allTokens;

    event Launched(
        address indexed token,
        address indexed creator,
        address pool,
        string name,
        string symbol,
        uint256 totalSupply,
        uint256 cyberLiquidity
    );
    event LaunchTerms(
        address indexed token, uint256 positionId, uint24 poolFee, uint16 creatorBps, uint16 holdersBps, uint16 protocolBps
    );
    event CreditOpened(address indexed token, Id borrowCyberMarket, Id borrowTokenMarket);
    event FarmOpened(address indexed token, address gauge);
    event ZoneOpened(address indexed token, string zone);
    event DAOOpened(address indexed token, address governor, address timelock);
    event MetadataSet(address indexed token, string uri);
    event SettingsChanged();

    error BadMetadata();
    error BadSupply();
    error BadFee();
    error NotEnoughCyber();
    error PriceOutOfRange();
    error NotLaunched();
    error AlreadyOpen();
    error ModuleNotSet();
    error NotCreator();
    error OnlyWrappedNative();

    constructor(
        address authority,
        IV3Factory dexFactory_,
        IV3PositionManager positions_,
        IWETH9 wcyber_,
        LaunchLocker locker_,
        ILending lending_,
        OracleFactory oracles_,
        LiquidityVaultFactory vaults_,
        uint256 minLiquidity_
    ) AccessManaged(authority) {
        dexFactory = dexFactory_;
        positions = positions_;
        wcyber = wcyber_;
        locker = locker_;
        lending = lending_;
        oracles = oracles_;
        vaults = vaults_;
        minLiquidity = minLiquidity_;
        tokenImplementation = address(new LaunchToken(wcyber_, address(this)));
    }

    // -------------------------------------------------------------------------------- views

    function isLaunched(address token) public view returns (bool) {
        return _economies[token].pool != address(0);
    }

    function economyOf(address token) external view returns (Economy memory) {
        return _economies[token];
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice The address a launch by `creator` with `salt` will have
    function predictToken(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(tokenImplementation, _salt(creator, salt));
    }

    /// @notice What a launch with these terms costs a trader and how its fee is split
    function quote(uint24 creatorFee, uint16 holdersShareBps)
        public
        pure
        returns (uint24 poolFee, uint16 creatorBps, uint16 holdersBps, uint16 protocolBps)
    {
        if (creatorFee > MAX_CREATOR_FEE || holdersShareBps > BPS) revert BadFee();
        poolFee = creatorFee + PROTOCOL_FEE;

        // Floors throughout, so the protocol's remainder is never short of its 1%.
        uint16 creatorSide = uint16(uint256(BPS) * creatorFee / poolFee);
        holdersBps = uint16(uint256(creatorSide) * holdersShareBps / BPS);
        creatorBps = creatorSide - holdersBps;
        protocolBps = BPS - creatorSide;
    }

    // ------------------------------------------------------------------------------- launch

    function launch(LaunchParams calldata p) external payable returns (address token) {
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert BadMetadata();
        if (p.totalSupply == 0 || p.totalSupply > MAX_SUPPLY) revert BadSupply();
        if (msg.value < minLiquidity || msg.value == 0) revert NotEnoughCyber();

        token = Clones.cloneDeterministic(tokenImplementation, _salt(msg.sender, p.salt));
        LaunchToken(payable(token)).initialize(p.name, p.symbol, p.totalSupply, _exclusions());

        Economy storage e = _economies[token];
        e.creator = msg.sender;
        e.launchedAt = uint64(block.timestamp);
        e.metadataURI = p.metadataURI;
        allTokens.push(token);

        (uint24 poolFee, uint16 creatorBps, uint16 holdersBps, uint16 protocolBps) =
            quote(p.creatorFee, p.holdersShareBps);

        e.pool = _openPool(token, p.totalSupply, poolFee);
        e.positionId = _lockFullRange(token, e.pool, p.totalSupply, msg.sender, creatorBps, holdersBps);
        _refundDust(token, msg.sender);

        // The vault is opened in the launch itself, never later: the token must exclude it while
        // it is still empty, and only here is that guaranteed.
        e.vault = vaults.create(e.pool);
        LaunchToken(payable(token)).exclude(e.vault);

        emit Launched(token, msg.sender, e.pool, p.name, p.symbol, p.totalSupply, msg.value);
        emit LaunchTerms(token, e.positionId, poolFee, creatorBps, holdersBps, protocolBps);

        if (p.kit & KIT_CREDIT != 0 && creditLltv != 0) _openCredit(token, e);
        if (p.kit & KIT_FARM != 0 && address(gauges) != address(0)) _openFarm(token, e);
        if (p.kit & KIT_ZONE != 0 && address(zones) != address(0)) {
            // A name that spells no zone is not a reason to fail a launch.
            try zones.createZone(token) returns (string memory zone) {
                e.zone = true;
                emit ZoneOpened(token, zone);
            } catch {}
        }
        if (p.kit & KIT_DAO != 0 && address(daos) != address(0)) _openDao(token, e);
    }

    // --------------------------------------------------------------------- the kit, later

    function openCredit(address token) external {
        Economy storage e = _launched(token);
        if (e.tokenOracle != address(0)) revert AlreadyOpen();
        if (creditLltv == 0) revert ModuleNotSet();
        _openCredit(token, e);
    }

    function openFarm(address token) external {
        Economy storage e = _launched(token);
        if (e.gauge != address(0)) revert AlreadyOpen();
        if (address(gauges) == address(0)) revert ModuleNotSet();
        _openFarm(token, e);
    }

    function openZone(address token) external {
        Economy storage e = _launched(token);
        if (e.zone) revert AlreadyOpen();
        if (address(zones) == address(0)) revert ModuleNotSet();
        e.zone = true;
        emit ZoneOpened(token, zones.createZone(token));
    }

    function openDAO(address token) external {
        Economy storage e = _launched(token);
        if (e.governor != address(0)) revert AlreadyOpen();
        if (address(daos) == address(0)) revert ModuleNotSet();
        _openDao(token, e);
    }

    /// @notice Point the token's page at a description, links and an image (an `ipfs://` URI)
    function setMetadata(address token, string calldata uri) external {
        Economy storage e = _launched(token);
        if (msg.sender != e.creator) revert NotCreator();
        e.metadataURI = uri;
        emit MetadataSet(token, uri);
    }

    // ------------------------------------------------------------------------- governance

    function setMinLiquidity(uint256 value) external restricted {
        minLiquidity = value;
        emit SettingsChanged();
    }

    function setCredit(address irm, uint256 lltv, uint32 window, uint32 minWindow) external restricted {
        creditIrm = irm;
        creditLltv = lltv;
        twapWindow = window;
        twapMinWindow = minWindow;
        emit SettingsChanged();
    }

    function setObservationCardinality(uint16 value) external restricted {
        observationCardinality = value;
        emit SettingsChanged();
    }

    function setModules(IGaugeRegistry gauges_, IZoneRegistry zones_, IDAOFactory daos_) external restricted {
        gauges = gauges_;
        zones = zones_;
        daos = daos_;
        emit SettingsChanged();
    }

    // -------------------------------------------------------------------------- internals

    function _launched(address token) internal view returns (Economy storage e) {
        e = _economies[token];
        if (e.pool == address(0)) revert NotLaunched();
    }

    function _salt(address creator, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    /// @dev Contracts that will hold the token for others and must never earn its dividend.
    function _exclusions() internal view returns (address[] memory accounts) {
        accounts = new address[](3);
        accounts[0] = address(lending);
        accounts[1] = address(locker);
        accounts[2] = locker.treasury();
    }

    function _openPool(address token, uint256 supply, uint24 poolFee) internal returns (address pool) {
        wcyber.deposit{value: msg.value}();

        pool = dexFactory.createPool(token, address(wcyber), LAUNCH_TIER);
        LaunchToken(payable(token)).setPool(pool);

        (uint256 amount0, uint256 amount1) = token < address(wcyber) ? (supply, msg.value) : (msg.value, supply);
        IV3Pool(pool).initialize(_sqrtPriceX96(amount0, amount1));

        if (poolFee < LAUNCH_TIER) dexFactory.setPoolFeeByCreator(pool, poolFee);
        IV3Pool(pool).increaseObservationCardinalityNext(observationCardinality);
    }

    function _lockFullRange(
        address token,
        address pool,
        uint256 supply,
        address creator,
        uint16 creatorBps,
        uint16 holdersBps
    ) internal returns (uint256 positionId) {
        (address token0, address token1) = token < address(wcyber) ? (token, address(wcyber)) : (address(wcyber), token);
        (uint256 amount0, uint256 amount1) = token0 == token ? (supply, msg.value) : (msg.value, supply);

        int24 spacing = IV3Pool(pool).tickSpacing();
        IERC20(token0).forceApprove(address(positions), amount0);
        IERC20(token1).forceApprove(address(positions), amount1);

        (positionId,,,) = positions.mint(
            IV3PositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: LAUNCH_TIER,
                tickLower: (TickMath.MIN_TICK / spacing) * spacing,
                tickUpper: (TickMath.MAX_TICK / spacing) * spacing,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        IERC20(token0).forceApprove(address(positions), 0);
        IERC20(token1).forceApprove(address(positions), 0);

        positions.safeTransferFrom(
            address(this), address(locker), positionId, abi.encode(creator, creatorBps, holdersBps, token)
        );
    }

    /// @dev A full-range mint takes almost but not exactly both amounts: the token's few wei leave
    /// circulation, the CYBER's go back to the creator.
    function _refundDust(address token, address creator) internal {
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) IERC20(token).safeTransfer(BURN, tokenDust);

        uint256 wrappedDust = wcyber.balanceOf(address(this));
        if (wrappedDust > 0) {
            wcyber.withdraw(wrappedDust);
            (bool ok,) = creator.call{value: wrappedDust}("");
            // A creator that refuses the coin gets the wrapped dust instead of failing the launch.
            if (!ok) {
                wcyber.deposit{value: wrappedDust}();
                wcyber.transfer(creator, wrappedDust);
            }
        }
    }

    function _openCredit(address token, Economy storage e) internal {
        address tokenOracle = oracles.twap(e.pool, token, twapWindow, twapMinWindow);
        address cyberOracle = oracles.twap(e.pool, address(wcyber), twapWindow, twapMinWindow);

        MarketParams memory borrowCyber = MarketParams(address(wcyber), token, tokenOracle, creditIrm, creditLltv);
        MarketParams memory borrowToken = MarketParams(token, address(wcyber), cyberOracle, creditIrm, creditLltv);
        _ensureMarket(borrowCyber);
        _ensureMarket(borrowToken);

        e.tokenOracle = tokenOracle;
        e.cyberOracle = cyberOracle;
        e.borrowCyberMarket = borrowCyber.id();
        e.borrowTokenMarket = borrowToken.id();

        emit CreditOpened(token, e.borrowCyberMarket, e.borrowTokenMarket);
    }

    function _ensureMarket(MarketParams memory params) internal {
        (,,,, uint128 lastUpdate,) = lending.market(params.id());
        if (lastUpdate == 0) lending.createMarket(params);
    }

    function _openFarm(address token, Economy storage e) internal {
        address gauge = gauges.gaugeOf(e.vault);
        if (gauge == address(0)) gauge = gauges.createGauge(e.vault, e.creator);
        e.gauge = gauge;
        emit FarmOpened(token, gauge);
    }

    function _openDao(address token, Economy storage e) internal {
        (address governor, address timelock) = daos.createDAO(token);
        e.governor = governor;
        e.timelock = timelock;
        emit DAOOpened(token, governor, timelock);
    }

    /// @dev sqrt(amount1 / amount0) in Q64.96, the price the pool opens at.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        // amount1 / amount0 must stay under 2^64 for the Q192 ratio to fit in a word.
        if (amount1 >> 64 >= amount0) revert PriceOutOfRange();
        uint256 root = Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0));
        if (root < TickMath.MIN_SQRT_RATIO || root >= TickMath.MAX_SQRT_RATIO) revert PriceOutOfRange();
        return uint160(root);
    }

    /// @dev Receives the position NFT on its way to the locker.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev Unwrapping dust sends the coin here on its way back to the creator.
    receive() external payable {
        if (msg.sender != address(wcyber)) revert OnlyWrappedNative();
    }
}
