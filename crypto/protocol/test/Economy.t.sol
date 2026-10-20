// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

import {ProtocolHarness} from "./utils/ProtocolHarness.sol";
import {Launchpad} from "../contracts/launch/Launchpad.sol";
import {LaunchToken} from "../contracts/tokens/LaunchToken.sol";
import {LiquidityVault} from "../contracts/liquidity/LiquidityVault.sol";
import {Gauge} from "../contracts/incentives/Gauge.sol";
import {TokenGovernor} from "../contracts/governance/TokenGovernor.sol";
import {Epoch} from "../contracts/libraries/Epoch.sol";
import {Domains} from "../contracts/identity/Domains.sol";

/// One launch, end to end: every part of the kit, and every way the economy pays someone.
contract EconomyTest is ProtocolHarness {
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address lp = makeAddr("lp");
    address locker_ = makeAddr("ashLocker");

    uint256 constant SUPPLY = 1_000_000_000e18;
    uint8 constant FULL_KIT = 1 | 2 | 4 | 8;

    address token;
    Launchpad.Economy e;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployProtocol();
        _deployEconomy();

        vm.deal(creator, 1_000 ether);
        vm.prank(creator);
        token = launchpad.launch{value: 100 ether}(_params(".moon", "DOTMOON", SUPPLY, 50_000, 5_000, FULL_KIT));
        e = launchpad.economyOf(token);

        _fundWrapped(trader, 500 ether);
        _fundWrapped(lp, 500 ether);
    }

    function test_theKitOpensEverything() public view {
        assertTrue(e.tokenOracle != address(0), "credit");
        assertTrue(e.gauge != address(0), "farm");
        assertTrue(e.zone, "zone");
        assertTrue(e.governor != address(0) && e.timelock != address(0), "DAO");
        assertEq(Gauge(e.gauge).manager(), creator, "the creator may stream extra rewards");
        assertEq(Gauge(e.gauge).stakingToken().balanceOf(address(0)), 0);
        assertEq(address(Gauge(e.gauge).stakingToken()), e.vault, "the farm stakes the LP vault's shares");
        assertEq(domains.zoneOfToken(token), "moon");
        assertTrue(LaunchToken(payable(token)).excluded(address(voter)), "incentives in escrow earn no dividend");
    }

    function test_aNameThatSpellsNoZoneStillLaunches() public {
        Launchpad.LaunchParams memory p = _params("Plain", "PLAIN", SUPPLY, 0, 0, FULL_KIT);
        p.salt = bytes32(uint256(1));
        vm.prank(creator);
        address plain = launchpad.launch{value: 10 ether}(p);
        assertFalse(launchpad.economyOf(plain).zone);
        assertTrue(launchpad.economyOf(plain).gauge != address(0));
    }

    // --------------------------------------------------------------------------------- votes

    /// The flywheel: lockers vote for the launch, the launch's protocol fees pay them for it.
    function test_votersOfALaunchAreIncentivizedByItsFees() public {
        ash.transfer(locker_, 1_000_000e18);
        vm.startPrank(locker_);
        ash.approve(address(ve), type(uint256).max);
        ve.createLock(1_000_000e18, 104 weeks);
        address[] memory gauges = new address[](1);
        gauges[0] = e.gauge;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        voter.vote(gauges, weights);
        vm.stopPrank();
        uint256 epoch = Epoch.current();

        for (uint256 i = 0; i < 3; i++) {
            uint256 bought = _buy(trader, token, 20 ether);
            _sell(trader, token, bought);
        }
        router.harvestLaunch(e.positionId);

        // Buys paid 60 CYBER in: a 6% fee, the protocol's 1/6 of it, half of that to the voters.
        uint256 incentive = voter.incentives(epoch, e.gauge, address(wcyber));
        assertApproxEqRel(incentive, 0.3 ether, 0.01e18);

        vm.warp(Epoch.start(epoch + 1) + 1);
        address[] memory tokens = new address[](2);
        tokens[0] = address(wcyber);
        tokens[1] = token;
        vm.prank(locker_);
        voter.claimIncentives(epoch, e.gauge, tokens);
        assertApproxEqAbs(wcyber.balanceOf(locker_), incentive, 1);
        assertGt(IERC20(token).balanceOf(locker_), 0, "and the token side of the fees too");
    }

    function test_lpsInTheLaunchFarmEarnAsh() public {
        // Lockers vote for the launch farm this week...
        ash.transfer(locker_, 1_000_000e18);
        vm.startPrank(locker_);
        ash.approve(address(ve), type(uint256).max);
        ve.createLock(1_000_000e18, 104 weeks);
        address[] memory gauges = new address[](1);
        gauges[0] = e.gauge;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        voter.vote(gauges, weights);
        vm.stopPrank();
        minter.start(1_000_000e18);

        // ...an LP provides liquidity and stakes the vault shares...
        LiquidityVault vault = LiquidityVault(e.vault);
        _buy(lp, token, 50 ether);
        vm.startPrank(lp);
        IERC20(token).approve(address(vault), type(uint256).max);
        wcyber.approve(address(vault), type(uint256).max);
        (uint256 a0, uint256 a1) = token < address(wcyber)
            ? (IERC20(token).balanceOf(lp), wcyber.balanceOf(lp))
            : (wcyber.balanceOf(lp), IERC20(token).balanceOf(lp));
        (uint256 shares,,) = vault.deposit(a0, a1, 1, lp);
        vault.approve(e.gauge, shares);
        Gauge(e.gauge).deposit(shares, lp);
        vm.stopPrank();

        // ...and next week's emission flows to them.
        uint256 next = Epoch.current() + 1;
        vm.warp(Epoch.start(next) + 1);
        minter.updatePeriod();
        voter.distribute(e.gauge, next);
        skip(7 days);
        Gauge(e.gauge).getReward(lp);

        assertApproxEqRel(ash.balanceOf(lp), 950_000e18, 0.001e18, "the whole voter share of the week");
    }

    // ------------------------------------------------------------------------------- revenue

    function test_routerSplitsTheRestAsTheCoin() public {
        for (uint256 i = 0; i < 3; i++) {
            uint256 bought = _buy(trader, token, 20 ether);
            _sell(trader, token, bought);
        }
        router.harvestLaunch(e.positionId); // no gauge votes yet: nothing goes to voters

        uint256 held = wcyber.balanceOf(address(router));
        assertGt(held, 0);
        router.distributeNative();
        assertApproxEqAbs(treasury.balance, held * 8 / 10, 1);
        assertApproxEqAbs(gasTank.balance, held * 2 / 10, 1);

        // The token side of the fees goes only where a token is of use: never to the gas tank.
        uint256 tokens = IERC20(token).balanceOf(address(router));
        assertGt(tokens, 0);
        router.distribute(token);
        assertEq(IERC20(token).balanceOf(gasTank), 0);
        assertEq(IERC20(token).balanceOf(treasury), tokens);
    }

    // ---------------------------------------------------------------------------------- names

    function test_namesInTheZoneBurnTheToken() public {
        uint256 bought = _buy(trader, token, 50 ether);
        (,,, uint256 fee,) = domains.zone("moon");
        assertEq(fee, SUPPLY / 1_000_000);

        uint256 burnedBefore = IERC20(token).balanceOf(domains.BURN());
        vm.startPrank(trader);
        IERC20(token).approve(address(domains), fee);
        uint256 id = domains.register("lain", "moon");
        domains.setPrimary(id);
        vm.stopPrank();

        assertEq(IERC20(token).balanceOf(trader), bought - fee);
        assertEq(IERC20(token).balanceOf(domains.BURN()) - burnedBefore, fee, "the fee is burned");
        assertEq(domains.primaryName(trader), "lain.moon");

        // A name sold on loses its holder's records and stops being their primary name.
        string[] memory keys = new string[](1);
        keys[0] = "A";
        string[] memory values = new string[](1);
        values[0] = "203.0.113.7";
        vm.prank(trader);
        domains.setRecords(id, keys, values);

        vm.prank(trader);
        domains.transferFrom(trader, lp, id);
        (, string[] memory after_) = domains.resolve("lain", "moon", keys);
        assertEq(after_[0], "", "the new holder starts with no records");
        assertEq(domains.primaryName(trader), "");
    }

    function test_rootNamesCostCyberAndRespectReservations() public {
        string[] memory labels = new string[](1);
        labels[0] = "lain";
        domains.reserve(labels, true);

        vm.deal(trader, 2 ether);
        vm.prank(trader);
        vm.expectRevert(Domains.Reserved.selector);
        domains.register{value: 1 ether}("lain", "cyber");

        vm.prank(trader);
        domains.register{value: 1 ether}("wired", "cyber");
        assertEq(address(router).balance, 1 ether, "paid to the revenue router");
    }

    // ------------------------------------------------------------------------------------ DAO

    function test_theTokensDaoGovernsByTime() public {
        TokenGovernor governor = TokenGovernor(payable(e.governor));
        assertEq(governor.CLOCK_MODE(), "mode=timestamp");

        // Buy past the proposal threshold, delegate, and hand the timelock something to govern.
        uint256 bought = _buy(trader, token, 200 ether);
        vm.startPrank(trader);
        LaunchToken(payable(token)).delegate(trader);
        IERC20(token).transfer(e.timelock, bought / 10);
        vm.stopPrank();
        skip(1);

        address[] memory targets = new address[](1);
        targets[0] = token;
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeCall(IERC20.transfer, (lp, bought / 10));

        vm.prank(trader);
        uint256 proposalId = governor.propose(targets, values, calldatas, "pay the LP");

        skip(1 days + 1);
        vm.prank(trader);
        governor.castVote(proposalId, 1);
        skip(5 days);

        governor.queue(targets, values, calldatas, keccak256("pay the LP"));
        skip(2 days);
        governor.execute(targets, values, calldatas, keccak256("pay the LP"));

        assertEq(IERC20(token).balanceOf(lp), bought / 10);
        assertEq(uint8(governor.state(proposalId)), uint8(IGovernor.ProposalState.Executed));
    }
}
