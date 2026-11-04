// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Lending} from "../contracts/lending/Lending.sol";
import {AdaptiveCurveIrm} from "../contracts/lending/irm/AdaptiveCurveIrm.sol";
import {CreditVault} from "../contracts/lending/CreditVault.sol";
import {CreditVaultFactory} from "../contracts/lending/CreditVaultFactory.sol";
import {MarketParams, Id} from "../contracts/lending/interfaces/ILending.sol";
import {MarketParamsLib} from "../contracts/lending/MarketParamsLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockOracle} from "./mocks/MockOracle.sol";

contract CreditVaultTest is Test {
    using MarketParamsLib for MarketParams;

    AccessManager authority;
    Lending lending;
    AdaptiveCurveIrm irm;
    CreditVaultFactory factory;
    CreditVault vault;
    MockERC20 cyber;
    MockERC20 moon;
    MockERC20 mars;
    MockOracle oracle;
    MarketParams moonMarket;
    MarketParams marsMarket;

    address curator = makeAddr("curator");
    address alice = makeAddr("alice");
    address borrower = makeAddr("borrower");

    function setUp() public {
        vm.warp(1_800_000_000);
        authority = new AccessManager(address(this));
        lending = new Lending(address(authority), makeAddr("router"));
        irm = new AdaptiveCurveIrm(address(lending));
        lending.enableIrm(address(irm));
        lending.enableLltv(0.5e18);

        cyber = new MockERC20("Wrapped CYBER", "WCYBER", 18);
        moon = new MockERC20("Moon", "MOON", 18);
        mars = new MockERC20("Mars", "MARS", 18);
        oracle = new MockOracle();
        oracle.setPrice(1e36);

        moonMarket = MarketParams(address(cyber), address(moon), address(oracle), address(irm), 0.5e18);
        marsMarket = MarketParams(address(cyber), address(mars), address(oracle), address(irm), 0.5e18);
        lending.createMarket(moonMarket);
        lending.createMarket(marsMarket);

        factory = new CreditVaultFactory(lending);
        vault = CreditVault(factory.createVault(IERC20(address(cyber)), "Launch Credit", "lcCYBER", curator));

        vm.startPrank(curator);
        vault.setCap(moonMarket, 60e18);
        vault.setCap(marsMarket, 30e18);
        vm.stopPrank();

        cyber.mint(alice, 1_000e18);
        vm.prank(alice);
        cyber.approve(address(vault), type(uint256).max);
    }

    function _supplied(MarketParams memory params) internal view returns (uint256) {
        (uint256 shares,,) = lending.position(params.id(), address(vault));
        (uint128 assets, uint128 totalShares,,,,) = lending.market(params.id());
        return totalShares == 0 ? 0 : shares * (uint256(assets) + 1) / (uint256(totalShares) + 1e6);
    }

    function _borrow(MarketParams memory params, MockERC20 collateral, uint256 amount) internal {
        collateral.mint(borrower, amount * 4);
        vm.startPrank(borrower);
        collateral.approve(address(lending), type(uint256).max);
        lending.supplyCollateral(params, amount * 4, borrower, "");
        lending.borrow(params, amount, 0, borrower, borrower);
        vm.stopPrank();
    }

    function test_depositsFillTheQueueUpToCaps() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);

        assertApproxEqAbs(_supplied(moonMarket), 60e18, 1);
        assertApproxEqAbs(_supplied(marsMarket), 30e18, 1);
        assertEq(vault.idle(), 10e18, "beyond every cap, the rest waits");
        assertApproxEqAbs(vault.totalAssets(), 100e18, 2);
    }

    function test_onlyTheCuratorSetsCapsOnItsOwnAsset() public {
        vm.prank(alice);
        vm.expectRevert(CreditVault.NotCurator.selector);
        vault.setCap(moonMarket, 1);

        MarketParams memory wrongAsset = MarketParams(address(moon), address(cyber), address(oracle), address(irm), 0.5e18);
        lending.createMarket(wrongAsset);
        vm.prank(curator);
        vm.expectRevert(CreditVault.WrongAsset.selector);
        vault.setCap(wrongAsset, 1);
    }

    function test_interestRaisesTheShareAndPaysTheCurator() public {
        vm.prank(curator);
        vault.setFee(0.1e18, curator);

        vm.prank(alice);
        uint256 shares = vault.deposit(90e18, alice);
        _borrow(moonMarket, moon, 50e18);

        skip(365 days);
        vm.prank(alice);
        vault.deposit(1, alice); // any interaction accrues the fee

        assertGt(vault.balanceOf(curator), 0, "fee taken as shares");
        assertGt(vault.convertToAssets(shares), 90e18, "depositors earned");
    }

    function test_withdrawalsDrainTheQueueAndRespectLiquidity() public {
        vm.prank(alice);
        vault.deposit(90e18, alice);
        _borrow(moonMarket, moon, 55e18); // the moon market is now mostly lent out

        uint256 max = vault.maxWithdraw(alice);
        assertApproxEqAbs(max, 35e18, 2, "only what the markets can pay");

        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(max + 1e18, alice, alice);

        vm.prank(alice);
        vault.withdraw(max, alice, alice);
        assertApproxEqAbs(cyber.balanceOf(alice), 1_000e18 - 90e18 + max, 1);
    }

    function test_allocatorMovesMoney() public {
        vm.prank(alice);
        vault.deposit(90e18, alice);

        CreditVault.Allocation[] memory plan = new CreditVault.Allocation[](2);
        plan[0] = CreditVault.Allocation(moonMarket, 30e18);
        plan[1] = CreditVault.Allocation(marsMarket, 30e18);
        vm.prank(curator);
        vault.reallocate(plan);

        assertApproxEqAbs(_supplied(moonMarket), 30e18, 2);
        assertApproxEqAbs(vault.idle(), 30e18, 2);

        vm.prank(alice);
        vm.expectRevert(CreditVault.NotAllocator.selector);
        vault.reallocate(plan);
    }

    function test_aMarketWithMoneyInItCannotBeDropped() public {
        vm.prank(alice);
        vault.deposit(10e18, alice);

        Id id = moonMarket.id();
        vm.prank(curator);
        vm.expectRevert(CreditVault.NotEmpty.selector);
        vault.removeMarket(id);
    }
}
