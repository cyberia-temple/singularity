// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {CyberiaVpnPass} from "./CyberiaVpnPass.sol";

/// A treasury that refuses payment, so a purchase fails rather than granting
/// days nobody was paid for.
contract RejectingTreasury {
    receive() external payable {
        revert("no thanks");
    }
}

contract CyberiaVpnPassTest is Test {
    CyberiaVpnPass pass;

    address owner = address(0x0FFE);
    address payable fees = payable(address(0x54BB));
    address payable treasury = payable(address(0x7EA5));
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant PRICE = 10 ether;

    function setUp() public {
        pass = new CyberiaVpnPass(owner, PRICE, 1_000, fees, treasury);
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
        vm.warp(1_800_000_000);
    }

    function test_buy_splits_the_payment_and_sets_expiry() public {
        vm.prank(alice);
        uint64 until = pass.buy{value: 30 * PRICE}(alice, 30);

        assertEq(until, block.timestamp + 30 days);
        assertEq(pass.expiresAt(alice), until);
        assertTrue(pass.isActive(alice));
        assertEq(fees.balance, 30 ether);
        assertEq(treasury.balance, 270 ether);
        assertEq(address(pass).balance, 0);
    }

    function test_days_are_added_to_what_is_left() public {
        vm.prank(alice);
        pass.buy{value: 7 * PRICE}(alice, 7);
        vm.warp(block.timestamp + 2 days);

        vm.prank(alice);
        uint64 until = pass.buy{value: 7 * PRICE}(alice, 7);

        assertEq(until, block.timestamp - 2 days + 14 days);
    }

    function test_an_expired_pass_restarts_from_now() public {
        vm.prank(alice);
        pass.buy{value: PRICE}(alice, 1);
        vm.warp(block.timestamp + 10 days);
        assertFalse(pass.isActive(alice));

        vm.prank(alice);
        uint64 until = pass.buy{value: PRICE}(alice, 1);

        assertEq(until, block.timestamp + 1 days);
    }

    function test_anyone_can_pay_for_someone_else() public {
        vm.prank(bob);
        pass.buy{value: PRICE}(alice, 1);

        assertTrue(pass.isActive(alice));
        assertFalse(pass.isActive(bob));
    }

    function test_payment_must_be_exact() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CyberiaVpnPass.WrongPayment.selector, 2 * PRICE));
        pass.buy{value: 2 * PRICE + 1}(alice, 2);
    }

    function test_days_are_bounded() public {
        vm.startPrank(alice);
        vm.expectRevert(CyberiaVpnPass.BadDays.selector);
        pass.buy{value: 0}(alice, 0);
        vm.expectRevert(CyberiaVpnPass.BadDays.selector);
        pass.buy{value: 367 * PRICE}(alice, 367);
        vm.stopPrank();
    }

    function test_pause_stops_sales_not_passes() public {
        vm.prank(alice);
        pass.buy{value: PRICE}(alice, 1);
        vm.prank(owner);
        pass.setPaused(true);

        vm.prank(bob);
        vm.expectRevert(CyberiaVpnPass.Paused.selector);
        pass.buy{value: PRICE}(bob, 1);
        assertTrue(pass.isActive(alice));
    }

    function test_only_owner_sets_policy_and_fee_is_capped() public {
        vm.prank(alice);
        vm.expectRevert(CyberiaVpnPass.NotOwner.selector);
        pass.setPrice(1);

        vm.startPrank(owner);
        vm.expectRevert(CyberiaVpnPass.FeeTooHigh.selector);
        pass.setFee(2_001, fees);
        pass.setFee(0, fees);
        pass.setPrice(1 ether);
        vm.stopPrank();

        vm.prank(alice);
        pass.buy{value: 1 ether}(alice, 1);
        assertEq(fees.balance, 0);
        assertEq(treasury.balance, 1 ether);
    }

    function test_a_refused_payout_grants_nothing() public {
        RejectingTreasury bad = new RejectingTreasury();
        vm.prank(owner);
        pass.setTreasury(payable(address(bad)));

        vm.prank(alice);
        vm.expectRevert(CyberiaVpnPass.PayoutFailed.selector);
        pass.buy{value: PRICE}(alice, 1);
        assertEq(pass.expiresAt(alice), 0);
    }
}
