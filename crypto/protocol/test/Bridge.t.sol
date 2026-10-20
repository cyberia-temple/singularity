// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";

import {BridgeGateway} from "../contracts/bridge/BridgeGateway.sol";
import {BridgedToken} from "../contracts/bridge/BridgedToken.sol";

contract BridgeTest is Test {
    uint64 constant SOLANA = 900;
    uint64 constant ROBINHOOD = 4663;
    uint64 constant RELAYER_ROLE = 10;

    AccessManager authority;
    BridgeGateway gateway;
    BridgedToken usdc;

    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");

    function setUp() public {
        authority = new AccessManager(address(this));
        gateway = new BridgeGateway(address(authority));

        bytes4[] memory relayerCalls = new bytes4[](3);
        relayerCalls[0] = BridgeGateway.release.selector;
        relayerCalls[1] = BridgeGateway.finalize.selector;
        relayerCalls[2] = BridgeGateway.refund.selector;
        authority.setTargetFunctionRole(address(gateway), relayerCalls, RELAYER_ROLE);
        authority.grantRole(RELAYER_ROLE, relayer, 0);

        usdc = BridgedToken(gateway.createWrapped("USD Coin", "USDC", 6, SOLANA, bytes32("EPjFWdd5AufqSSqeM2qN1xzybapC")));
        // At most 10,000 USDC at once, refilled at 1 USDC a second.
        gateway.setAsset(address(usdc), BridgeGateway.Kind.Wrapped, 10_000e6, 1e6, true, 1e6);
        gateway.setAsset(address(0), BridgeGateway.Kind.Lockbox, 1_000 ether, 0.1 ether, true, 0.01 ether);
        gateway.setDestination(SOLANA, true);
        gateway.setDestination(ROBINHOOD, true);
        gateway.setRefundDelay(3 days);
    }

    function _release(address token, address to, uint256 amount, bytes32 sourceId) internal {
        vm.prank(relayer);
        gateway.release(token, to, amount, sourceId);
    }

    // ------------------------------------------------------------------------------------- in

    function test_releaseMintsOncePerSource() public {
        _release(address(usdc), alice, 100e6, "sol-tx-1");
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(usdc.decimals(), 6);

        vm.prank(relayer);
        vm.expectRevert(BridgeGateway.AlreadyReleased.selector);
        gateway.release(address(usdc), alice, 100e6, "sol-tx-1");
    }

    function test_onlyTheRelayerReleases() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, alice));
        gateway.release(address(usdc), alice, 1e6, "x");
    }

    /// The old wrappers let the relayer key mint without limit. A stolen key now mints one bucket.
    function test_stolenKeyMintsOneBucketAtMost() public {
        _release(address(usdc), alice, 10_000e6, "a");

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeGateway.RateLimited.selector, 0));
        gateway.release(address(usdc), alice, 1e6, "b");

        skip(100);
        assertEq(gateway.availableToRelease(address(usdc)), 100e6, "refills at the set rate");
        _release(address(usdc), alice, 100e6, "c");
    }

    function test_nobodyCanBurnAHoldersTokens() public {
        _release(address(usdc), alice, 100e6, "a");
        vm.expectRevert(BridgedToken.NotGateway.selector);
        usdc.burn(1);
        vm.expectRevert(BridgedToken.NotGateway.selector);
        usdc.mint(address(this), 1);
    }

    function test_lockboxReleasesOnlyWhatIsNotEscrowed() public {
        vm.deal(address(gateway), 5 ether);

        // Alice escrows 2 CYBER on its way out; only the other 5 can be released inbound.
        vm.deal(alice, 2 ether);
        vm.prank(alice);
        gateway.bridgeOut{value: 2 ether}(address(0), 2 ether, ROBINHOOD, abi.encodePacked(alice));

        vm.prank(relayer);
        vm.expectRevert(BridgeGateway.InsufficientReserve.selector);
        gateway.release(address(0), alice, 6 ether, "c");

        _release(address(0), alice, 5 ether, "d");
        assertEq(alice.balance, 5 ether);
    }

    // ------------------------------------------------------------------------------------ out

    function test_outboundIsEscrowedThenBurned() public {
        _release(address(usdc), alice, 100e6, "a");

        vm.startPrank(alice);
        usdc.approve(address(gateway), 40e6);
        uint256 nonce = gateway.bridgeOut(address(usdc), 40e6, SOLANA, bytes("6ZbN5fE9cDmA4o2gk7r5i1UQx3pQ8gQb"));
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(gateway)), 40e6, "held, not burned, until the payout is confirmed");
        assertEq(usdc.totalSupply(), 100e6);

        vm.prank(relayer);
        gateway.finalize(nonce, "solana-payout-sig");
        assertEq(usdc.totalSupply(), 60e6);
        assertEq(uint8(gateway.outbound(nonce).status), uint8(BridgeGateway.Status.Finalized));
    }

    function test_relayerRefundsWhatItCannotPay() public {
        _release(address(usdc), alice, 100e6, "a");
        vm.startPrank(alice);
        usdc.approve(address(gateway), 40e6);
        uint256 nonce = gateway.bridgeOut(address(usdc), 40e6, SOLANA, bytes("dest"));
        vm.stopPrank();

        vm.prank(relayer);
        gateway.refund(nonce);
        assertEq(usdc.balanceOf(alice), 100e6);

        vm.prank(relayer);
        vm.expectRevert(BridgeGateway.NotPending.selector);
        gateway.finalize(nonce, "late");
    }

    function test_senderRefundsAfterSilence() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        uint256 nonce = gateway.bridgeOut{value: 1 ether}(address(0), 1 ether, ROBINHOOD, abi.encodePacked(alice));

        vm.prank(alice);
        vm.expectRevert(BridgeGateway.NotYetRefundable.selector);
        gateway.refund(nonce);

        skip(3 days);
        vm.prank(alice);
        gateway.refund(nonce);
        assertEq(alice.balance, 1 ether);
    }

    function test_strangersCannotRefund() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        uint256 nonce = gateway.bridgeOut{value: 1 ether}(address(0), 1 ether, ROBINHOOD, abi.encodePacked(alice));

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, stranger));
        gateway.refund(nonce);
    }

    function test_unknownDestinationAndDustAreRefused() public {
        _release(address(usdc), alice, 100e6, "a");
        vm.startPrank(alice);
        usdc.approve(address(gateway), type(uint256).max);
        vm.expectRevert(BridgeGateway.UnknownDestination.selector);
        gateway.bridgeOut(address(usdc), 10e6, 1, bytes("x"));
        vm.expectRevert(BridgeGateway.BadAmount.selector);
        gateway.bridgeOut(address(usdc), 0.5e6, SOLANA, bytes("x"));
        vm.stopPrank();
    }

    function test_pauseStopsBothDirections() public {
        gateway.setPaused(true);
        vm.prank(relayer);
        vm.expectRevert(BridgeGateway.IsPaused.selector);
        gateway.release(address(usdc), alice, 1e6, "a");

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(BridgeGateway.IsPaused.selector);
        gateway.bridgeOut{value: 1 ether}(address(0), 1 ether, ROBINHOOD, abi.encodePacked(alice));
    }

    function test_wrappedAddressIsDerivedFromItsOrigin() public {
        vm.expectRevert(); // the same origin cannot be wrapped twice
        gateway.createWrapped("USD Coin", "USDC", 6, SOLANA, bytes32("EPjFWdd5AufqSSqeM2qN1xzybapC"));
    }
}
