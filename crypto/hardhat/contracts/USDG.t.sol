// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {USDG} from "./USDG.sol";

contract USDGTest is Test {
    USDG token;
    address relayer = address(0xBEEF);
    address alice = address(0xA11CE);

    function setUp() public {
        token = new USDG(relayer);
    }

    function test_metadataAndEmptySupply() public view {
        assertEq(token.name(), "Global Dollar");
        assertEq(token.symbol(), "USDG");
        assertEq(token.decimals(), 6);
        assertEq(token.owner(), relayer);
        assertEq(token.totalSupply(), 0);
    }

    function test_relayerMintsAndBurnsWithoutAllowance() public {
        vm.startPrank(relayer);
        token.mint(alice, 10_000_000);
        token.burnFrom(alice, 3_000_000);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 7_000_000);
        assertEq(token.totalSupply(), 7_000_000);
    }

    function test_othersCannotMintOrBurnAnotherAccount() public {
        vm.expectRevert("Ownable: caller is not the owner");
        token.mint(alice, 1);
        vm.prank(relayer);
        token.mint(alice, 10_000_000);
        vm.expectRevert("ERC20: insufficient allowance");
        token.burnFrom(alice, 1);
    }
}
