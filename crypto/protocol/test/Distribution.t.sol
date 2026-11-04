// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";

import {Ash} from "../contracts/tokens/Ash.sol";
import {VotingEscrow} from "../contracts/incentives/VotingEscrow.sol";
import {BuildersFund} from "../contracts/incentives/BuildersFund.sol";
import {PioneerDrop} from "../contracts/incentives/PioneerDrop.sol";

/// Two-leaf Merkle trees, built the way OpenZeppelin's MerkleProof checks them.
abstract contract MerkleHelper {
    function _leaf(address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    function _root(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _proof(bytes32 sibling) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }
}

contract DistributionTest is Test, MerkleHelper {
    AccessManager authority;
    Ash ash;
    VotingEscrow ve;
    BuildersFund fund;
    PioneerDrop drop;

    address dev = makeAddr("dev");
    address maintainer = makeAddr("maintainer");
    address pioneer = makeAddr("pioneer");
    address latecomer = makeAddr("latecomer");

    function setUp() public {
        vm.warp(1_800_000_000);
        authority = new AccessManager(address(this));
        ash = new Ash(address(authority), 100_000_000e18, address(this), 5_000_000e18);
        ve = new VotingEscrow(ash);
        fund = new BuildersFund(address(authority), ash);
        drop = new PioneerDrop(address(authority), ash, ve, 52 weeks, address(fund));
        ash.transfer(address(drop), 5_000_000e18);
    }

    // ------------------------------------------------------------------------------- builders

    function test_aRoundPaysWhatItListed() public {
        vm.prank(address(drop));
        ash.transfer(address(fund), 1_000e18);

        bytes32 a = _leaf(dev, 600e18);
        bytes32 b = _leaf(maintainer, 400e18);
        uint256 round = fund.publishRound(_root(a, b), 1_000e18, "ipfs://round-0-merged-prs");

        fund.claim(round, dev, 600e18, _proof(b)); // anyone may submit it
        assertEq(ash.balanceOf(dev), 600e18);

        vm.expectRevert(BuildersFund.AlreadyClaimed.selector);
        fund.claim(round, dev, 600e18, _proof(b));
        vm.expectRevert(BuildersFund.BadProof.selector);
        fund.claim(round, maintainer, 500e18, _proof(a));
    }

    function test_aRoundCannotPromiseMoreThanTheFundHolds() public {
        vm.prank(address(drop));
        ash.transfer(address(fund), 1_000e18);
        fund.publishRound(bytes32(uint256(1)), 800e18, "");

        vm.expectRevert(abi.encodeWithSelector(BuildersFund.OverCommitted.selector, 200e18));
        fund.publishRound(bytes32(uint256(2)), 300e18, "");
    }

    // -------------------------------------------------------------------------------- pioneers

    function test_pioneersReceiveALockNotATokenToSell() public {
        bytes32 a = _leaf(pioneer, 30_000e18);
        bytes32 b = _leaf(latecomer, 10_000e18);
        drop.setRoot(_root(a, b), uint64(block.timestamp + 12 weeks));

        drop.claim(pioneer, 30_000e18, _proof(b));
        assertEq(ash.balanceOf(pioneer), 0, "nothing liquid");
        (uint128 locked, uint64 end,) = ve.locks(pioneer);
        assertEq(locked, 30_000e18);
        assertGe(end, block.timestamp + 51 weeks);
        assertGt(ve.votingPower(pioneer), 0, "votes from day one");
    }

    function test_aDropAddsToAnExistingLock() public {
        vm.prank(address(drop));
        ash.transfer(pioneer, 100e18);
        vm.startPrank(pioneer);
        ash.approve(address(ve), 100e18);
        ve.createLock(100e18, 10 weeks);
        vm.stopPrank();

        bytes32 a = _leaf(pioneer, 1_000e18);
        bytes32 b = _leaf(latecomer, 1e18);
        drop.setRoot(_root(a, b), uint64(block.timestamp + 12 weeks));
        drop.claim(pioneer, 1_000e18, _proof(b));

        (uint128 locked,,) = ve.locks(pioneer);
        assertEq(locked, 1_100e18);
    }

    function test_unclaimedGoesToTheBuilders() public {
        bytes32 a = _leaf(pioneer, 1e18);
        bytes32 b = _leaf(latecomer, 1e18);
        drop.setRoot(_root(a, b), uint64(block.timestamp + 12 weeks));

        vm.expectRevert(PioneerDrop.StillOpen.selector);
        drop.sweep();

        skip(13 weeks);
        vm.expectRevert(PioneerDrop.Closed.selector);
        drop.claim(pioneer, 1e18, _proof(b));

        drop.sweep();
        assertEq(ash.balanceOf(address(fund)), 5_000_000e18);
    }
}
