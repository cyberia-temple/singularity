// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IV3Factory, IV3Pool, IV3PositionManager, IWETH9} from "../../contracts/interfaces/IV3.sol";
import {WCYBER} from "../../contracts/tokens/WCYBER.sol";
import {Lending} from "../../contracts/lending/Lending.sol";
import {AdaptiveCurveIrm} from "../../contracts/lending/irm/AdaptiveCurveIrm.sol";
import {OracleFactory} from "../../contracts/oracles/OracleFactory.sol";
import {LiquidityVaultFactory} from "../../contracts/liquidity/LiquidityVaultFactory.sol";
import {LaunchLocker} from "../../contracts/launch/LaunchLocker.sol";
import {Launchpad} from "../../contracts/launch/Launchpad.sol";
import {TickMath} from "../../contracts/libraries/TickMath.sol";
import {Ash} from "../../contracts/tokens/Ash.sol";
import {VotingEscrow} from "../../contracts/incentives/VotingEscrow.sol";
import {Voter} from "../../contracts/incentives/Voter.sol";
import {Minter} from "../../contracts/incentives/Minter.sol";
import {RevenueRouter} from "../../contracts/treasury/RevenueRouter.sol";
import {Domains} from "../../contracts/identity/Domains.sol";
import {DAOFactory} from "../../contracts/governance/DAOFactory.sol";
import {IGaugeRegistry, IZoneRegistry, IDAOFactory, ILaunchRegistry} from
    "../../contracts/launch/interfaces/IEconomyModules.sol";

interface IPoolDeployer {
    function setFactoryAddress(address factory) external;
}

interface IFactoryAdmin {
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
    function setFeeCollector(address collector) external;
    function setFeeProtocol(address pool, uint32 feeProtocol0, uint32 feeProtocol1) external;
}

/// @notice Swaps directly against a pool and pays in the callback, so tests need no router.
contract Swapper {
    function swap(IV3Pool pool, address tokenIn, uint256 amountIn, address recipient) external returns (uint256 out) {
        bool zeroForOne = tokenIn == pool.token0();
        (int256 amount0, int256 amount1) = pool.swap(
            recipient,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            abi.encode(msg.sender, tokenIn)
        );
        out = uint256(-(zeroForOne ? amount1 : amount0));
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        (address payer, address tokenIn) = abi.decode(data, (address, address));
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        IERC20(tokenIn).transferFrom(payer, msg.sender, owed);
    }
}

/// @notice The whole protocol on a test chain: V3 from the vendored artifacts, the 0.8 contracts on top.
abstract contract ProtocolHarness is Test {
    uint24 constant LAUNCH_TIER = 110_000;
    uint256 constant LAUNCH_LLTV = 0.5e18;

    AccessManager authority;
    WCYBER wcyber;
    IV3Factory dexFactory;
    IV3PositionManager positions;
    Lending lending;
    AdaptiveCurveIrm irm;
    OracleFactory oracles;
    LiquidityVaultFactory vaults;
    LaunchLocker locker;
    Launchpad launchpad;
    Swapper swapper;

    Ash ash;
    VotingEscrow ve;
    Voter voter;
    Minter minter;
    RevenueRouter router;
    Domains domains;
    DAOFactory daos;

    address treasury = makeAddr("treasury");
    address gasTank = makeAddr("gasTank");

    uint64 constant LAUNCHPAD_ROLE = 20;

    function _deployProtocol() internal {
        authority = new AccessManager(address(this));
        wcyber = new WCYBER();

        address poolDeployer = deployCode("PancakeV3PoolDeployer");
        dexFactory = IV3Factory(deployCode("PancakeV3Factory", abi.encode(poolDeployer)));
        IPoolDeployer(poolDeployer).setFactoryAddress(address(dexFactory));
        IFactoryAdmin(address(dexFactory)).enableFeeAmount(LAUNCH_TIER, 200);

        address descriptor = deployCode("NonfungibleTokenPositionDescriptorOffChain", abi.encode("ipfs://"));
        positions = IV3PositionManager(
            deployCode("NonfungiblePositionManager", abi.encode(poolDeployer, dexFactory, wcyber, descriptor))
        );

        lending = new Lending(address(authority), treasury);
        irm = new AdaptiveCurveIrm(address(lending));
        lending.enableIrm(address(irm));
        lending.enableLltv(LAUNCH_LLTV);

        oracles = new OracleFactory();
        vaults = new LiquidityVaultFactory(dexFactory);
        locker = new LaunchLocker(address(authority), positions, treasury);

        launchpad = new Launchpad(
            address(authority),
            dexFactory,
            positions,
            IWETH9(address(wcyber)),
            locker,
            lending,
            oracles,
            vaults,
            1 ether
        );
        locker.setLauncher(address(launchpad), true);
        launchpad.setCredit(address(irm), LAUNCH_LLTV, 30 minutes, 10 minutes);

        swapper = new Swapper();
    }

    /// @dev Everything else a launch's economy plugs into, wired the way the deploy script wires it:
    /// the router receives every protocol fee, the launchpad may create gauges, and the kit modules
    /// are set on the launchpad.
    function _deployEconomy() internal {
        ash = new Ash(address(authority), 100_000_000e18, address(this), 10_000_000e18);
        ve = new VotingEscrow(ash);

        RevenueRouter.Share[] memory nativeShares = new RevenueRouter.Share[](2);
        nativeShares[0] = RevenueRouter.Share(treasury, 8_000);
        nativeShares[1] = RevenueRouter.Share(gasTank, 2_000);
        RevenueRouter.Share[] memory tokenShares = new RevenueRouter.Share[](1);
        tokenShares[0] = RevenueRouter.Share(treasury, 10_000);
        router = new RevenueRouter(
            address(authority), dexFactory, positions, IWETH9(address(wcyber)), lending, vaults, nativeShares, tokenShares
        );

        voter = new Voter(address(authority), ve, address(router));
        minter = new Minter(address(authority), ash, voter, 9_900, treasury, 500);
        ash.setMinter(address(minter));
        voter.setMinter(address(minter));

        router.setModules(locker, voter);
        router.setVotersBps(5_000);
        locker.setTreasury(address(router));
        lending.setFeeRecipient(address(router));
        IFactoryAdmin(address(dexFactory)).setFeeCollector(address(router));

        domains = new Domains(address(authority), ILaunchRegistry(address(launchpad)), address(router), 1 ether);
        daos = new DAOFactory();

        bytes4[] memory gaugeCalls = new bytes4[](1);
        gaugeCalls[0] = Voter.createGauge.selector;
        authority.setTargetFunctionRole(address(voter), gaugeCalls, LAUNCHPAD_ROLE);
        authority.grantRole(LAUNCHPAD_ROLE, address(launchpad), 0);
        authority.grantRole(LAUNCHPAD_ROLE, address(this), 0);

        launchpad.setModules(
            IGaugeRegistry(address(voter)), IZoneRegistry(address(domains)), IDAOFactory(address(daos))
        );
        address[] memory escrows = new address[](1);
        escrows[0] = address(voter);
        launchpad.setRewardExclusions(escrows);
    }

    function _params(string memory name, string memory symbol, uint256 supply, uint24 creatorFee, uint16 holdersShare, uint8 kit)
        internal
        pure
        returns (Launchpad.LaunchParams memory)
    {
        return Launchpad.LaunchParams({
            name: name,
            symbol: symbol,
            totalSupply: supply,
            creatorFee: creatorFee,
            holdersShareBps: holdersShare,
            salt: bytes32(0),
            kit: kit,
            metadataURI: ""
        });
    }

    /// @dev Wrap `amount` CYBER for `who` and approve the swapper and the lending book to spend it.
    function _fundWrapped(address who, uint256 amount) internal {
        vm.deal(who, amount);
        vm.startPrank(who);
        wcyber.deposit{value: amount}();
        wcyber.approve(address(swapper), type(uint256).max);
        wcyber.approve(address(lending), type(uint256).max);
        vm.stopPrank();
    }

    function _buy(address who, address token, uint256 cyberIn) internal returns (uint256 out) {
        Launchpad.Economy memory e = launchpad.economyOf(token);
        vm.prank(who);
        out = swapper.swap(IV3Pool(e.pool), address(wcyber), cyberIn, who);
    }

    function _sell(address who, address token, uint256 tokensIn) internal returns (uint256 out) {
        Launchpad.Economy memory e = launchpad.economyOf(token);
        vm.startPrank(who);
        IERC20(token).approve(address(swapper), type(uint256).max);
        out = swapper.swap(IV3Pool(e.pool), token, tokensIn, who);
        vm.stopPrank();
    }
}
