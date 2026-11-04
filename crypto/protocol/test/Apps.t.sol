// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";

import {GasStation} from "../contracts/apps/GasStation.sol";
import {Badges} from "../contracts/identity/Badges.sol";
import {CommunityToken} from "../contracts/community/CommunityToken.sol";
import {CommunityTokenFactory} from "../contracts/community/CommunityTokenFactory.sol";
import {DAOFactory} from "../contracts/governance/DAOFactory.sol";

contract AppsTest is Test {
    uint64 constant OPERATOR_ROLE = 30;

    AccessManager authority;
    GasStation station;
    Badges badges;

    address operator = makeAddr("operator");
    address newcomer = makeAddr("newcomer");

    function setUp() public {
        authority = new AccessManager(address(this));
        station = new GasStation(address(authority));
        badges = new Badges(address(authority), "ipfs://badges/{id}.json");

        bytes4[] memory claimCall = new bytes4[](1);
        claimCall[0] = GasStation.claim.selector;
        authority.setTargetFunctionRole(address(station), claimCall, OPERATOR_ROLE);
        bytes4[] memory awardCalls = new bytes4[](2);
        awardCalls[0] = Badges.award.selector;
        awardCalls[1] = Badges.awardBatch.selector;
        authority.setTargetFunctionRole(address(badges), awardCalls, OPERATOR_ROLE);
        authority.grantRole(OPERATOR_ROLE, operator, 0);

        vm.deal(address(station), 1 ether);
    }

    // ----------------------------------------------------------------------------- gas station

    function test_dripOnceThenCoolDown() public {
        vm.prank(operator);
        station.claim(payable(newcomer));
        assertEq(newcomer.balance, 0.01 ether);

        // Spending it back below the ceiling is not enough: the cooldown holds.
        vm.prank(newcomer);
        payable(address(0xdead)).transfer(0.01 ether);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(GasStation.NotEligible.selector, "cooling down"));
        station.claim(payable(newcomer));

        skip(6 hours);
        vm.prank(operator);
        station.claim(payable(newcomer));
    }

    function test_addressesWithGasGetNothing() public {
        vm.deal(newcomer, 1 ether);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(GasStation.NotEligible.selector, "has gas"));
        station.claim(payable(newcomer));
    }

    function test_aStolenOperatorKeyIsCappedPerDay() public {
        station.setPolicy(0.01 ether, 0.001 ether, 6 hours, 0.03 ether);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(operator);
            station.claim(payable(address(uint160(1000 + i))));
        }
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(GasStation.NotEligible.selector, "daily cap reached"));
        station.claim(payable(address(2000)));
    }

    function test_onlyTheOperatorDrips() public {
        vm.prank(newcomer);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, newcomer));
        station.claim(payable(newcomer));
    }

    // ---------------------------------------------------------------------------------- badges

    function test_badgesAreAwardedOnceAndStay() public {
        vm.startPrank(operator);
        badges.award(newcomer, 1);
        badges.award(newcomer, 1);
        vm.stopPrank();
        assertEq(badges.balanceOf(newcomer, 1), 1, "idempotent");

        vm.prank(newcomer);
        vm.expectRevert(Badges.Soulbound.selector);
        badges.safeTransferFrom(newcomer, operator, 1, 1, "");
    }

    // ---------------------------------------------------------------------- community tokens

    function test_chatTokenMintsUpToItsCapAndOpensADao() public {
        CommunityTokenFactory factory = new CommunityTokenFactory();
        address bot = makeAddr("bot");
        CommunityToken token = CommunityToken(factory.createToken("Wired Chat", "WIRED", bot, 1_000e18));

        vm.prank(bot);
        token.mint(newcomer, 600e18);
        vm.prank(bot);
        vm.expectRevert(CommunityToken.CapExceeded.selector);
        token.mint(newcomer, 401e18);
        vm.prank(newcomer);
        vm.expectRevert(CommunityToken.NotOwner.selector);
        token.mint(newcomer, 1);

        (address governor, address timelock) = new DAOFactory().createDAO(address(token));
        assertTrue(governor != address(0) && timelock != address(0));
    }
}
