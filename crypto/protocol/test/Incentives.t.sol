// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";

import {Ash} from "../contracts/tokens/Ash.sol";
import {VotingEscrow} from "../contracts/incentives/VotingEscrow.sol";
import {Voter} from "../contracts/incentives/Voter.sol";
import {Gauge} from "../contracts/incentives/Gauge.sol";
import {Minter, ILockedCyber} from "../contracts/incentives/Minter.sol";
import {Epoch} from "../contracts/libraries/Epoch.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract MockLaunchpad {
    uint256 public totalCyberLocked;

    function lock(uint256 amount) external {
        totalCyberLocked += amount;
    }
}

contract IncentivesTest is Test {
    uint256 constant WEEK = 7 days;
    uint256 constant CAP = 100_000_000e18;
    /// The first week's kindling: 100k ASH, 3/4 of it to the voter after builders and treasury.
    uint256 constant WEEKLY = 100_000e18;
    uint256 constant TO_VOTER = WEEKLY * 7_500 / 10_000;
    address constant BLACKHOLE = 0x0100000000000000000000000000000000000000;

    AccessManager authority;
    Ash ash;
    VotingEscrow ve;
    Voter voter;
    Minter minter;
    MockLaunchpad launches;
    MockERC20 lpA;
    MockERC20 lpB;
    MockERC20 bribe;
    Gauge gaugeA;
    Gauge gaugeB;

    address treasury = makeAddr("treasury");
    address builders = makeAddr("builders");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address farmer = makeAddr("farmer");
    address project = makeAddr("project");

    function setUp() public {
        vm.warp(1_800_000_000); // a fixed point well inside an epoch
        authority = new AccessManager(address(this));
        ash = new Ash(address(authority), CAP, address(this), 10_000_000e18);
        ve = new VotingEscrow(ash);
        voter = new Voter(address(authority), ve, treasury);
        launches = new MockLaunchpad();
        // 100 ASH per CYBER of fire; no week above 1% of what is left; kindling falls 4% a week.
        minter = new Minter(address(authority), ash, voter, ILockedCyber(address(launches)), 100, 100, 9_600);
        minter.setSplit(builders, 1_500, treasury, 1_000);
        ash.setMinter(address(minter));
        voter.setMinter(address(minter));

        lpA = new MockERC20("LP A", "LPA", 18);
        lpB = new MockERC20("LP B", "LPB", 18);
        bribe = new MockERC20("Bribe", "BRB", 18);
        gaugeA = Gauge(voter.createGauge(address(lpA), project));
        gaugeB = Gauge(voter.createGauge(address(lpB), address(0)));

        _lock(alice, 3_000_000e18, 104 weeks);
        _lock(bob, 1_000_000e18, 104 weeks);
    }

    function _lock(address who, uint256 amount, uint256 duration) internal {
        ash.transfer(who, amount);
        vm.startPrank(who);
        ash.approve(address(ve), amount);
        ve.createLock(amount, duration);
        vm.stopPrank();
    }

    function _vote(address who, address gauge) internal {
        address[] memory gauges = new address[](1);
        gauges[0] = gauge;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        vm.prank(who);
        voter.vote(gauges, weights);
    }

    function _nextEpoch() internal {
        vm.warp(Epoch.next() + 1);
    }

    // ---------------------------------------------------------------------------------- escrow

    function test_votingPowerDecaysToZero() public {
        uint256 start = ve.votingPower(alice);
        (, uint64 end,) = ve.locks(alice);
        assertEq(end % WEEK, 0, "locks end on an epoch boundary");

        vm.warp(block.timestamp + (end - block.timestamp) / 2);
        assertApproxEqRel(ve.votingPower(alice), start / 2, 0.01e18);

        vm.warp(end);
        assertEq(ve.votingPower(alice), 0);

        vm.prank(alice);
        ve.withdraw();
        assertEq(ash.balanceOf(alice), 3_000_000e18);
    }

    function test_permanentLockKeepsFullPower() public {
        vm.prank(alice);
        ve.lockPermanent();
        vm.warp(block.timestamp + 3 * 365 days);
        assertEq(ve.votingPower(alice), 3_000_000e18);

        vm.prank(alice);
        vm.expectRevert(VotingEscrow.Permanent.selector);
        ve.withdraw();

        vm.prank(alice);
        ve.unlockPermanent();
        assertLt(ve.votingPower(alice), 3_000_000e18);
    }

    function test_cannotWithdrawEarly() public {
        vm.prank(alice);
        vm.expectRevert(VotingEscrow.StillLocked.selector);
        ve.withdraw();
    }

    // --------------------------------------------------------------------------------- gauges

    function test_onlyGovernanceOrLaunchpadCreatesGauges() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, alice));
        voter.createGauge(address(bribe), alice);
    }

    // -------------------------------------------------------------------------------- emission

    function test_emissionFollowsLastWeeksVotes() public {
        minter.start(WEEKLY);
        _vote(alice, address(gaugeA)); // 3/4 of the votes
        _vote(bob, address(gaugeB)); // 1/4

        _nextEpoch();
        minter.updatePeriod();
        uint256 epoch = Epoch.current();

        voter.distribute(address(gaugeA), epoch);
        voter.distribute(address(gaugeB), epoch);

        assertApproxEqRel(gaugeA.left(address(ash)), TO_VOTER * 3 / 4, 0.0001e18);
        assertApproxEqRel(gaugeB.left(address(ash)), TO_VOTER / 4, 0.0001e18);
        assertEq(ash.balanceOf(builders), WEEKLY * 1_500 / 10_000, "builders' share");
        assertEq(ash.balanceOf(treasury), WEEKLY * 1_000 / 10_000, "treasury share");

        vm.expectRevert(Voter.AlreadyDone.selector);
        voter.distribute(address(gaugeA), epoch);
    }

    // ------------------------------------------------------------------------------------ fire

    function test_burnedAndLockedCyberBecomeAsh() public {
        minter.start(0); // no kindling: only fire makes ASH
        uint256 burnedBefore = BLACKHOLE.balance;

        // A week of fire: 7 CYBER of fees burned, 30 CYBER locked by a launch.
        vm.deal(BLACKHOLE, burnedBefore + 7 ether);
        launches.lock(30 ether);
        (uint256 burned, uint256 locked) = minter.heat();
        assertEq(burned + locked, 37 ether);

        _nextEpoch();
        uint256 minted = minter.updatePeriod();
        assertEq(minted, 3_700e18, "100 ASH for every CYBER of fire");
        assertEq(minter.totalHeat(), 37 ether);

        // The heat is spent: next week starts cold.
        _nextEpoch();
        assertEq(minter.updatePeriod(), 0);
    }

    function test_aColdChainMakesNothingButKindling() public {
        minter.start(WEEKLY);
        uint256 previous = type(uint256).max;
        for (uint256 i = 0; i < 4; i++) {
            _nextEpoch();
            uint256 minted = minter.updatePeriod();
            assertLt(minted, previous, "kindling decays");
            previous = minted;
        }
        assertApproxEqRel(previous, WEEKLY * 96 ** 3 / 100 ** 3, 0.0001e18);
    }

    function test_noWeekMintsMoreThanItsCeiling() public {
        minter.start(0);
        uint256 room = ash.cap() - ash.totalSupply();

        // A whale burns half the CYBER supply in one week.
        vm.deal(BLACKHOLE, BLACKHOLE.balance + 500_000 ether);
        _nextEpoch();
        assertEq(minter.updatePeriod(), room / 100, "1% of what is left, and the rest of the heat is just gone");
        assertEq(ash.totalSupply() <= ash.cap(), true);
    }

    function test_unvotedEmissionWaitsForTheNextVote() public {
        minter.start(WEEKLY);
        _nextEpoch();
        minter.updatePeriod();
        uint256 epoch = Epoch.current();

        voter.rolloverUnvoted(epoch);
        assertEq(voter.emission(epoch), 0);
        assertEq(voter.emission(epoch + 1), TO_VOTER, "nothing leaks to the treasury");
    }

    function test_votesAreReplacedNotAdded() public {
        _vote(alice, address(gaugeA));
        _vote(alice, address(gaugeB));
        uint256 epoch = Epoch.current();
        assertEq(voter.gaugeVotes(epoch, address(gaugeA)), 0);
        assertEq(voter.gaugeVotes(epoch, address(gaugeB)), ve.votingPower(alice));
    }

    // ---------------------------------------------------------------------------------- farming

    function test_stakersEarnTheStream() public {
        minter.start(WEEKLY);
        _vote(alice, address(gaugeA));
        _nextEpoch();
        minter.updatePeriod();
        voter.distribute(address(gaugeA), Epoch.current());

        lpA.mint(farmer, 100e18);
        vm.startPrank(farmer);
        lpA.approve(address(gaugeA), type(uint256).max);
        gaugeA.deposit(100e18, farmer);
        vm.stopPrank();

        skip(WEEK);
        gaugeA.getReward(farmer);
        assertApproxEqRel(ash.balanceOf(farmer), TO_VOTER, 0.001e18, "the whole week, minus nothing lost");
    }

    function test_rewardsWhileNobodyStakesAreCarriedForward() public {
        minter.start(WEEKLY);
        _vote(alice, address(gaugeA));
        _nextEpoch();
        minter.updatePeriod();
        voter.distribute(address(gaugeA), Epoch.current());

        // Half the week passes with nobody staked.
        skip(WEEK / 2);
        lpA.mint(farmer, 1e18);
        vm.startPrank(farmer);
        lpA.approve(address(gaugeA), type(uint256).max);
        gaugeA.deposit(1e18, farmer);
        vm.stopPrank();

        skip(WEEK);
        uint256 streamed = gaugeA.earned(farmer, address(ash));
        assertApproxEqRel(gaugeA.left(address(ash)) + streamed, TO_VOTER, 0.001e18);
    }

    function test_projectStreamsItsOwnToken() public {
        bribe.mint(project, 700e18);
        vm.startPrank(project);
        bribe.approve(address(gaugeA), type(uint256).max);
        gaugeA.notifyRewardAmount(address(bribe), 700e18);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(Gauge.NotManager.selector);
        gaugeA.notifyRewardAmount(address(bribe), 1);

        lpA.mint(farmer, 10e18);
        vm.startPrank(farmer);
        lpA.approve(address(gaugeA), type(uint256).max);
        gaugeA.deposit(10e18, farmer);
        vm.stopPrank();

        skip(WEEK);
        gaugeA.getReward(farmer);
        assertApproxEqRel(bribe.balanceOf(farmer), 700e18, 0.001e18);
    }

    // ------------------------------------------------------------------------------ incentives

    function test_votersSplitIncentivesByVotes() public {
        _vote(alice, address(gaugeA));
        _vote(bob, address(gaugeA));
        uint256 epoch = Epoch.current();

        bribe.mint(project, 400e18);
        vm.startPrank(project);
        bribe.approve(address(voter), type(uint256).max);
        voter.incentivize(address(gaugeA), address(bribe), 400e18);
        vm.stopPrank();

        address[] memory tokens = new address[](1);
        tokens[0] = address(bribe);

        vm.prank(alice);
        vm.expectRevert(Voter.EpochNotOver.selector);
        voter.claimIncentives(epoch, address(gaugeA), tokens);

        _nextEpoch();
        vm.prank(alice);
        voter.claimIncentives(epoch, address(gaugeA), tokens);
        vm.prank(bob);
        voter.claimIncentives(epoch, address(gaugeA), tokens);

        assertApproxEqRel(bribe.balanceOf(alice), 300e18, 0.0001e18);
        assertApproxEqRel(bribe.balanceOf(bob), 100e18, 0.0001e18);

        vm.prank(alice);
        voter.claimIncentives(epoch, address(gaugeA), tokens);
        assertApproxEqRel(bribe.balanceOf(alice), 300e18, 0.0001e18, "a second claim pays nothing");
    }

    function test_unvotedIncentiveRollsOver() public {
        uint256 epoch = Epoch.current();
        bribe.mint(project, 100e18);
        vm.startPrank(project);
        bribe.approve(address(voter), type(uint256).max);
        voter.incentivize(address(gaugeB), address(bribe), 100e18);
        vm.stopPrank();

        _nextEpoch();
        voter.rolloverIncentive(epoch, address(gaugeB), address(bribe));
        // Not Epoch.current(): the IR optimizer may reuse the timestamp read before the warp.
        assertEq(voter.incentives(epoch + 1, address(gaugeB), address(bribe)), 100e18);
    }
}
