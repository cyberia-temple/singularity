// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ProtocolHarness} from "./utils/ProtocolHarness.sol";
import {IV3Pool, IWETH9} from "../contracts/interfaces/IV3.sol";
import {Launchpad} from "../contracts/launch/Launchpad.sol";
import {TokenStudio} from "../contracts/launch/TokenStudio.sol";
import {StudioToken} from "../contracts/tokens/StudioToken.sol";
import {Gauge} from "../contracts/incentives/Gauge.sol";
import {IGaugeRegistry, IZoneRegistry, IDAOFactory} from "../contracts/launch/interfaces/IEconomyModules.sol";

/// Tokens made to their creator's description, on the launch's economy.
contract TokenStudioTest is ProtocolHarness {
    address creator = makeAddr("creator");
    address team = makeAddr("team");
    address trader = makeAddr("trader");
    address stranger = makeAddr("stranger");

    uint256 constant POOL = 600_000_000e18;
    uint256 constant TEAM = 400_000_000e18;
    uint256 constant CAP = 2_000_000_000e18;
    uint8 constant FULL_KIT = 1 | 2 | 4 | 8;

    TokenStudio studio;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployProtocol();
        _deployEconomy();

        studio = new TokenStudio(
            address(authority),
            dexFactory,
            positions,
            IWETH9(address(wcyber)),
            locker,
            lending,
            oracles,
            vaults,
            1 ether,
            address(new StudioToken(IWETH9(address(wcyber))))
        );
        // Wired the way scripts/deploy-studio.ts wires it on a live chain.
        locker.setLauncher(address(studio), true);
        studio.setCredit(address(irm), LAUNCH_LLTV, 30 minutes, 10 minutes);
        authority.grantRole(LAUNCHPAD_ROLE, address(studio), 0);
        studio.setModules(IGaugeRegistry(address(voter)), IZoneRegistry(address(0)), IDAOFactory(address(daos)));
        studio.setRewardExclusions(launchpad.rewardExclusions());

        vm.deal(creator, 1_000 ether);
    }

    function _token(address minter, uint256 cap, uint8 kit) internal view returns (TokenStudio.TokenParams memory p) {
        TokenStudio.Allocation[] memory allocations = new TokenStudio.Allocation[](1);
        allocations[0] = TokenStudio.Allocation(team, TEAM);
        p = TokenStudio.TokenParams({
            name: "Studio",
            symbol: "STU",
            poolSupply: POOL,
            allocations: allocations,
            minter: minter,
            maxSupply: cap,
            creatorFee: 50_000,
            holdersShareBps: 5_000,
            salt: bytes32(0),
            kit: kit,
            metadataURI: ""
        });
    }

    function _create(TokenStudio.TokenParams memory p) internal returns (StudioToken) {
        vm.prank(creator);
        return StudioToken(payable(studio.create{value: 100 ether}(p)));
    }

    // ----------------------------------------------------------------------------- creation

    function test_createSplitsTheSupplyBetweenPoolAndAddresses() public {
        address predicted = studio.predictStudioToken(creator, bytes32(0));
        StudioToken token = _create(_token(creator, CAP, 0));
        assertEq(address(token), predicted);

        Launchpad.Economy memory e = studio.economyOf(address(token));
        assertEq(e.creator, creator);
        assertEq(IV3Pool(e.pool).fee(), 60_000, "5% creator fee + 1% protocol");
        assertEq(positions.ownerOf(e.positionId), address(locker), "the liquidity is locked for good");
        assertTrue(studio.isLaunched(address(token)));

        assertApproxEqAbs(token.balanceOf(e.pool), POOL, 1e6);
        assertEq(token.balanceOf(team), TEAM, "minted straight to the address named");
        assertEq(token.balanceOf(creator), 0);
        assertEq(token.totalSupply(), POOL + TEAM);
        assertEq(token.minter(), creator);
        assertEq(token.maxSupply(), CAP);
        assertTrue(token.mintable());
        assertGt(studio.totalCyberLocked(), 99 ether);
    }

    function test_theLaunchpadsRegistryIsUntouched() public {
        StudioToken token = _create(_token(creator, 0, 0));
        assertFalse(launchpad.isLaunched(address(token)), "a studio token is the studio's");
        assertEq(launchpad.allTokensLength(), 0);
        assertEq(studio.allTokensLength(), 1);
    }

    function test_refusesWhatCannotBeMade() public {
        TokenStudio.TokenParams memory p = _token(creator, 0, 0);

        p.poolSupply = 0;
        vm.prank(creator);
        vm.expectRevert(Launchpad.BadSupply.selector);
        studio.create{value: 100 ether}(p);

        p = _token(creator, 0, 0);
        p.allocations[0].to = address(0);
        vm.prank(creator);
        vm.expectRevert(TokenStudio.BadAllocation.selector);
        studio.create{value: 100 ether}(p);

        p = _token(creator, POOL, 0);
        vm.prank(creator);
        vm.expectRevert(StudioToken.CapExceeded.selector);
        studio.create{value: 100 ether}(p);

        p = _token(creator, 0, 0);
        vm.prank(creator);
        vm.expectRevert(Launchpad.NotEnoughCyber.selector);
        studio.create{value: 0.5 ether}(p);

        p = _token(creator, 0, 0);
        p.allocations = new TokenStudio.Allocation[](17);
        vm.prank(creator);
        vm.expectRevert(TokenStudio.BadAllocation.selector);
        studio.create{value: 100 ether}(p);
    }

    // ------------------------------------------------------------------------------ minting

    function test_theMinterMintsToAnyAddressUpToTheCap() public {
        StudioToken token = _create(_token(creator, CAP, 0));

        vm.prank(creator);
        token.mint(trader, 500_000_000e18);
        assertEq(token.balanceOf(trader), 500_000_000e18);

        vm.prank(creator);
        vm.expectRevert(StudioToken.CapExceeded.selector);
        token.mint(trader, 500_000_000e18 + 1);

        vm.prank(stranger);
        vm.expectRevert(StudioToken.NotMinter.selector);
        token.mint(stranger, 1);
    }

    function test_givingMintingUpFixesTheSupply() public {
        StudioToken token = _create(_token(creator, 0, 0));
        assertEq(token.maxSupply(), token.MAX_SUPPLY(), "no cap named: the token's own");

        vm.prank(creator);
        token.setMinter(address(0));
        assertFalse(token.mintable());

        vm.prank(creator);
        vm.expectRevert(StudioToken.NotMinter.selector);
        token.mint(creator, 1);
    }

    function test_aTokenWithoutMinterIsFixedFromTheStart() public {
        StudioToken token = _create(_token(address(0), 0, 0));
        assertFalse(token.mintable());

        vm.prank(creator);
        vm.expectRevert(StudioToken.NotMinter.selector);
        token.mint(creator, 1);
    }

    function test_holdersBurnWhatTheyHold() public {
        StudioToken token = _create(_token(creator, 0, 0));
        vm.prank(team);
        token.burn(TEAM / 4);
        assertEq(token.balanceOf(team), TEAM * 3 / 4);
        assertEq(token.totalSupply(), POOL + TEAM * 3 / 4);

        vm.prank(trader);
        vm.expectRevert();
        token.burnFrom(team, 1);
    }

    // ---------------------------------------------------------------------------------- kit

    function test_theKitOpensCreditFarmAndDao() public {
        StudioToken token = _create(_token(creator, CAP, FULL_KIT));
        Launchpad.Economy memory e = studio.economyOf(address(token));

        assertTrue(e.tokenOracle != address(0), "credit");
        assertTrue(e.gauge != address(0), "farm");
        assertTrue(e.governor != address(0) && e.timelock != address(0), "DAO");
        assertFalse(e.zone, "zones are the launchpad's");
        assertEq(Gauge(e.gauge).manager(), creator);
        assertTrue(token.excluded(address(voter)), "incentives in escrow earn no dividend");
        assertTrue(token.excluded(e.vault));
    }

    function test_theKitCanBeOpenedLaterByAnyone() public {
        StudioToken token = _create(_token(creator, 0, 0));
        vm.startPrank(stranger);
        studio.openCredit(address(token));
        studio.openDAO(address(token));
        vm.stopPrank();

        Launchpad.Economy memory e = studio.economyOf(address(token));
        assertTrue(e.tokenOracle != address(0));
        assertTrue(e.governor != address(0));
    }

    function test_mintingCanBeHandedToTheTokensDao() public {
        StudioToken token = _create(_token(creator, CAP, 8));
        address timelock = studio.economyOf(address(token)).timelock;

        vm.prank(creator);
        token.setMinter(timelock);

        vm.prank(timelock);
        token.mint(trader, 1e18);
        assertEq(token.balanceOf(trader), 1e18);

        vm.prank(creator);
        vm.expectRevert(StudioToken.NotMinter.selector);
        token.mint(creator, 1);
    }

    // ------------------------------------------------------------------------------- fees

    function test_tradingFeesReachCreatorHoldersAndProtocol() public {
        StudioToken token = _create(_token(creator, 0, 0));
        Launchpad.Economy memory e = studio.economyOf(address(token));

        _fundWrapped(trader, 50 ether);
        vm.prank(trader);
        swapper.swap(IV3Pool(e.pool), address(wcyber), 10 ether, trader);

        uint256 creatorBefore = wcyber.balanceOf(creator);
        locker.collect(e.positionId);
        assertApproxEqRel(wcyber.balanceOf(creator) - creatorBefore, 0.25 ether, 0.01e18);

        // The team and the trader hold everything outside the pool, and share the holders' part.
        uint256 shared = token.withdrawableRewardsOf(team) + token.withdrawableRewardsOf(trader);
        assertApproxEqRel(shared, 0.25 ether, 0.01e18);

        uint256 coinBefore = team.balance;
        vm.prank(team);
        token.claim();
        assertGt(team.balance, coinBefore, "paid out as the coin");
    }

    function test_mintingAfterADividendCannotTakeWhatWasEarned() public {
        StudioToken token = _create(_token(creator, 0, 0));
        Launchpad.Economy memory e = studio.economyOf(address(token));

        _fundWrapped(trader, 50 ether);
        vm.prank(trader);
        swapper.swap(IV3Pool(e.pool), address(wcyber), 10 ether, trader);
        locker.collect(e.positionId);
        uint256 teamEarned = token.withdrawableRewardsOf(team);

        // The largest mint there can be, right after a distribution.
        uint256 room = token.maxSupply() - token.totalSupply();
        vm.prank(creator);
        token.mint(creator, room);
        assertEq(token.withdrawableRewardsOf(creator), 0, "a fresh mint has earned nothing");
        assertEq(token.withdrawableRewardsOf(team), teamEarned);
    }

    function test_aDividendWaitsForAWholeEligibleToken() public {
        TokenStudio.TokenParams memory p = _token(creator, 0, 0);
        p.allocations = new TokenStudio.Allocation[](0);
        StudioToken token = _create(p);

        vm.deal(address(this), 1 ether);
        wcyber.deposit{value: 1 ether}();
        wcyber.transfer(address(token), 1 ether);
        assertEq(token.distribute(), 0, "nobody eligible: it waits");

        vm.prank(creator);
        token.mint(trader, 1e18);
        assertEq(token.distribute(), 1 ether);
        assertApproxEqAbs(token.withdrawableRewardsOf(trader), 1 ether, 1);
    }
}
