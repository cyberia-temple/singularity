// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";

import {PredictionMarket} from "../contracts/predict/PredictionMarket.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract PredictionMarketTest is Test {
    AccessManager authority;
    PredictionMarket pm;
    MockERC20 moon;

    address feeRecipient = makeAddr("router");
    address creator = makeAddr("creator");
    address yes1 = makeAddr("yes1");
    address yes2 = makeAddr("yes2");
    address no1 = makeAddr("no1");
    address proposer = makeAddr("proposer");
    address disputer = makeAddr("disputer");

    uint8 constant YES = 0;
    uint8 constant NO = 1;

    function setUp() public {
        authority = new AccessManager(address(this));
        pm = new PredictionMarket(address(authority), feeRecipient, 0.1 ether);
        moon = new MockERC20("Moon", "MOON", 18);

        address[6] memory everyone = [creator, yes1, yes2, no1, proposer, disputer];
        for (uint256 i = 0; i < everyone.length; i++) {
            vm.deal(everyone[i], 100 ether);
            moon.mint(everyone[i], 1_000e18);
            vm.prank(everyone[i]);
            moon.approve(address(pm), type(uint256).max);
        }
    }

    function _open(address asset, PredictionMarket.Mode mode) internal returns (uint256 id) {
        vm.prank(creator);
        id = pm.createMarket{value: 0.1 ether}("Will MOON flip LAIN by Friday?", 2, asset, uint64(block.timestamp + 1 days), mode, 100);
    }

    function _betToken(uint256 id, address who, uint8 outcome, uint256 amount) internal {
        vm.prank(who);
        pm.bet(id, outcome, amount);
    }

    // --------------------------------------------------------------------------------- basics

    function test_marketsInALaunchedToken() public {
        uint256 id = _open(address(moon), PredictionMarket.Mode.Creator);
        _betToken(id, yes1, YES, 300e18);
        _betToken(id, yes2, YES, 100e18);
        _betToken(id, no1, NO, 600e18);

        skip(1 days);
        vm.prank(creator);
        pm.resolveByCreator(id, YES);

        // Losers' 600 less 2% protocol and 1% creator fee = 582, split 3:1.
        vm.prank(yes1);
        assertEq(pm.claim(id), 300e18 + 436.5e18);
        vm.prank(yes2);
        assertEq(pm.claim(id), 100e18 + 145.5e18);
        assertEq(pm.owed(address(moon), feeRecipient), 12e18);
        assertEq(pm.owed(address(moon), creator), 6e18);

        vm.prank(no1);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        pm.claim(id);
    }

    function test_operatorMarketsAreRestricted() public {
        vm.prank(creator);
        vm.expectRevert(PredictionMarket.WrongMode.selector);
        pm.createMarket{value: 0.1 ether}("q", 2, address(0), uint64(block.timestamp + 1 days), PredictionMarket.Mode.Operator, 0);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, creator));
        pm.createOperatorMarket("q", 2, address(0), uint64(block.timestamp + 1 days));
    }

    function test_noBettingAfterClose() public {
        uint256 id = _open(address(moon), PredictionMarket.Mode.Creator);
        skip(1 days);
        vm.prank(yes1);
        vm.expectRevert(PredictionMarket.BettingClosed.selector);
        pm.bet(id, YES, 1e18);
    }

    // ----------------------------------------------------------------------------- optimistic

    function test_undisputedProposalStands() public {
        uint256 id = _open(address(moon), PredictionMarket.Mode.Optimistic);
        _betToken(id, yes1, YES, 100e18);
        _betToken(id, no1, NO, 100e18);

        vm.prank(proposer);
        vm.expectRevert(PredictionMarket.NotClosed.selector);
        pm.propose(id, YES);

        skip(1 days);
        vm.prank(proposer);
        pm.propose(id, YES); // bond: 5% of 200 = 10

        vm.expectRevert(PredictionMarket.LivenessRunning.selector);
        pm.finalize(id);

        skip(1 days);
        pm.finalize(id);
        assertEq(pm.owed(address(moon), proposer), 10e18, "bond comes back");

        vm.prank(yes1);
        pm.claim(id);
        assertEq(moon.balanceOf(yes1), 1_000e18 - 100e18 + 100e18 + 97e18);
    }

    function test_aLieCostsTheBond() public {
        uint256 id = _open(address(moon), PredictionMarket.Mode.Optimistic);
        _betToken(id, yes1, YES, 100e18);
        _betToken(id, no1, NO, 100e18);
        skip(1 days);

        vm.prank(proposer);
        pm.propose(id, NO); // wrong
        vm.prank(disputer);
        pm.dispute(id);

        pm.arbitrate(id, YES);
        assertEq(pm.owed(address(moon), disputer), 20e18, "the disputer takes both bonds");
        assertEq(pm.owed(address(moon), proposer), 0);

        vm.prank(disputer);
        pm.withdraw(address(moon));
        assertEq(moon.balanceOf(disputer), 1_010e18);
    }

    function test_onlyTheArbiterSettlesDisputes() public {
        uint256 id = _open(address(moon), PredictionMarket.Mode.Optimistic);
        _betToken(id, yes1, YES, 100e18);
        skip(1 days);
        vm.prank(proposer);
        pm.propose(id, YES);
        vm.prank(disputer);
        pm.dispute(id);

        vm.prank(yes1);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, yes1));
        pm.arbitrate(id, YES);
    }

    // ------------------------------------------------------------------------------- refunds

    function test_unansweredMarketsRefundEveryone() public {
        uint256 id = _open(address(moon), PredictionMarket.Mode.Creator);
        _betToken(id, yes1, YES, 100e18);
        _betToken(id, no1, NO, 50e18);

        skip(1 days + 30 days + 1);
        vm.prank(creator);
        vm.expectRevert(PredictionMarket.WindowLapsed.selector);
        pm.resolveByCreator(id, YES);

        vm.prank(yes1);
        assertEq(pm.claim(id), 100e18);
        vm.prank(no1);
        assertEq(pm.claim(id), 50e18);
    }

    /// A proposal left unfinalized past the window cannot be finalized afterwards -- stakes may
    /// already have been refunded -- and its bond comes back through reclaimBonds.
    function test_lateFinalizeIsImpossible() public {
        uint256 id = _open(address(moon), PredictionMarket.Mode.Optimistic);
        _betToken(id, yes1, YES, 100e18);
        _betToken(id, no1, NO, 100e18);
        skip(1 days);
        vm.prank(proposer);
        pm.propose(id, YES);

        skip(31 days);
        vm.prank(no1);
        pm.claim(id); // refunded
        vm.expectRevert(PredictionMarket.WindowLapsed.selector);
        pm.finalize(id);

        pm.reclaimBonds(id);
        assertEq(pm.owed(address(moon), proposer), 10e18);
    }

    function test_cancelBeforeCloseRefunds() public {
        uint256 id = _open(address(0), PredictionMarket.Mode.Creator);
        vm.prank(yes1);
        pm.bet{value: 1 ether}(id, YES, 1 ether);

        uint8 invalid = pm.INVALID();
        vm.prank(creator);
        pm.resolveByCreator(id, invalid);

        uint256 before = yes1.balance;
        vm.prank(yes1);
        pm.claim(id);
        assertEq(yes1.balance - before, 1 ether);
    }

    function test_multiOutcomeNativeMarket() public {
        vm.prank(creator);
        uint256 id = pm.createMarket{value: 0.1 ether}(
            "Which zone opens next?", 4, address(0), uint64(block.timestamp + 1 days), PredictionMarket.Mode.Creator, 0
        );
        vm.prank(yes1);
        pm.bet{value: 1 ether}(id, 2, 1 ether);
        vm.prank(no1);
        pm.bet{value: 3 ether}(id, 0, 3 ether);

        skip(1 days);
        vm.prank(creator);
        pm.resolveByCreator(id, 2);

        uint256 before = yes1.balance;
        vm.prank(yes1);
        pm.claim(id);
        assertEq(yes1.balance - before, 1 ether + 3 ether * 98 / 100);
    }
}
