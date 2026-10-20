// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ProtocolHarness} from "./utils/ProtocolHarness.sol";
import {IV3Pool} from "../contracts/interfaces/IV3.sol";
import {Launchpad} from "../contracts/launch/Launchpad.sol";
import {LaunchToken} from "../contracts/tokens/LaunchToken.sol";
import {LiquidityVault} from "../contracts/liquidity/LiquidityVault.sol";
import {V3TwapOracle} from "../contracts/oracles/V3TwapOracle.sol";
import {ILending, MarketParams} from "../contracts/lending/interfaces/ILending.sol";

contract LaunchpadTest is ProtocolHarness {
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address lender = makeAddr("lender");
    address lp = makeAddr("lp");

    uint256 constant SUPPLY = 1_000_000_000e18;
    uint256 constant SEED = 100 ether;

    function setUp() public {
        _deployProtocol();
        vm.deal(creator, 1_000 ether);
    }

    function _launch(uint8 kit) internal returns (address token) {
        vm.prank(creator);
        token = launchpad.launch{value: SEED}(_params("Moon", "MOON", SUPPLY, 50_000, 5_000, kit));
    }

    // ------------------------------------------------------------------------------- the launch

    function test_launchOpensPoolLockedForever() public {
        address predicted = launchpad.predictToken(creator, bytes32(0));
        address token = _launch(0);
        assertEq(token, predicted);

        Launchpad.Economy memory e = launchpad.economyOf(token);
        assertEq(e.creator, creator);
        assertEq(IV3Pool(e.pool).fee(), 60_000, "5% creator fee + 1% protocol");
        assertEq(positions.ownerOf(e.positionId), address(locker));
        assertTrue(launchpad.isLaunched(token));

        // All supply is in the pool (a few wei of dust were burned).
        assertApproxEqAbs(IERC20(token).balanceOf(e.pool), SUPPLY, 1e6);
        assertEq(IERC20(token).balanceOf(creator), 0, "the creator holds nothing at launch");
    }

    function test_launchTermsSplitTheFee() public view {
        (uint24 poolFee, uint16 creatorBps, uint16 holdersBps, uint16 protocolBps) = launchpad.quote(50_000, 5_000);
        assertEq(poolFee, 60_000);
        assertEq(uint256(creatorBps) + holdersBps + protocolBps, 10_000);
        assertEq(holdersBps, 4_166, "half of the creator's 5/6");
        assertEq(protocolBps, 1_667, "the protocol's 1/6, rounding in its favour");
    }

    function test_creatorFeeIsCapped() public {
        vm.prank(creator);
        vm.expectRevert(Launchpad.BadFee.selector);
        launchpad.launch{value: SEED}(_params("X", "X", SUPPLY, 100_001, 0, 0));
    }

    function test_needsMinimumLiquidity() public {
        vm.prank(creator);
        vm.expectRevert(Launchpad.NotEnoughCyber.selector);
        launchpad.launch{value: 0.5 ether}(_params("X", "X", SUPPLY, 0, 0, 0));
    }

    /// The old LaunchpadV3 could be bricked for good by creating the pool of the next token before
    /// it existed. The DEX factory now refuses a pool for an address with no code.
    function test_poolCannotBeOccupiedBeforeLaunch() public {
        address predicted = launchpad.predictToken(creator, bytes32(0));
        vm.expectRevert(bytes("NO_CODE"));
        dexFactory.createPool(predicted, address(wcyber), LAUNCH_TIER);

        _launch(0);
    }

    function test_sameCreatorSameSaltCannotLaunchTwice() public {
        _launch(0);
        vm.prank(creator);
        vm.expectRevert();
        launchpad.launch{value: SEED}(_params("Moon", "MOON", SUPPLY, 0, 0, 0));
    }

    // ---------------------------------------------------------------------------------- fees

    function test_tradingFeesReachCreatorHoldersAndProtocol() public {
        address token = _launch(0);
        Launchpad.Economy memory e = launchpad.economyOf(token);

        _fundWrapped(trader, 50 ether);
        uint256 bought = _buy(trader, token, 10 ether);
        assertGt(bought, 0);

        uint256 creatorBefore = wcyber.balanceOf(creator);
        locker.collect(e.positionId);

        // 6% of 10 CYBER = 0.6 CYBER of fees in WCYBER: 5/6·(1-½) to the creator, the same to holders.
        uint256 creatorGot = wcyber.balanceOf(creator) - creatorBefore;
        assertApproxEqRel(creatorGot, 0.25 ether, 0.01e18);
        assertApproxEqRel(wcyber.balanceOf(treasury), 0.1 ether, 0.01e18);

        // The trader is the only holder, so the whole holders' share is theirs.
        LaunchToken t = LaunchToken(payable(token));
        assertApproxEqRel(t.withdrawableRewardsOf(trader), 0.25 ether, 0.01e18);

        uint256 coinBefore = trader.balance;
        vm.prank(trader);
        t.claim();
        assertApproxEqRel(trader.balance - coinBefore, 0.25 ether, 0.01e18, "paid out as the coin");
    }

    function test_poolAndSystemContractsEarnNoDividend() public {
        address token = _launch(0);
        Launchpad.Economy memory e = launchpad.economyOf(token);
        LaunchToken t = LaunchToken(payable(token));

        assertTrue(t.excluded(e.pool));
        assertTrue(t.excluded(e.vault));
        assertTrue(t.excluded(address(lending)));
        assertTrue(t.excluded(address(locker)));
        assertTrue(t.excluded(treasury));
        assertEq(t.eligibleSupply(), 0, "nobody but the pool holds it yet");
    }

    function test_dividendFollowsBalanceThroughTransfers() public {
        address token = _launch(0);
        Launchpad.Economy memory e = launchpad.economyOf(token);
        LaunchToken t = LaunchToken(payable(token));

        _fundWrapped(trader, 50 ether);
        uint256 bought = _buy(trader, token, 10 ether);
        locker.collect(e.positionId);
        uint256 earnedBefore = t.withdrawableRewardsOf(trader);

        // Sending tokens away does not send away what was already earned.
        vm.prank(trader);
        t.transfer(lp, bought / 2);
        assertEq(t.withdrawableRewardsOf(trader), earnedBefore);
        assertEq(t.withdrawableRewardsOf(lp), 0);
    }

    // -------------------------------------------------------------------------------- credit

    function test_creditMarketsOpenWithTheLaunch() public {
        address token = _launch(launchpad.KIT_CREDIT());
        Launchpad.Economy memory e = launchpad.economyOf(token);

        assertTrue(e.tokenOracle != address(0));
        (address loanToken, address collateralToken,,, uint256 lltv) = lending.idToMarketParams(e.borrowCyberMarket);
        assertEq(loanToken, address(wcyber));
        assertEq(collateralToken, token);
        assertEq(lltv, LAUNCH_LLTV);
        (loanToken, collateralToken,,,) = lending.idToMarketParams(e.borrowTokenMarket);
        assertEq(loanToken, token);
        assertEq(collateralToken, address(wcyber));

        vm.expectRevert(Launchpad.AlreadyOpen.selector);
        launchpad.openCredit(token);
    }

    function test_noBorrowingUntilThePriceHasHistory() public {
        address token = _launch(launchpad.KIT_CREDIT());
        Launchpad.Economy memory e = launchpad.economyOf(token);
        MarketParams memory market = MarketParams(address(wcyber), token, e.tokenOracle, address(irm), LAUNCH_LLTV);

        _fundWrapped(lender, 100 ether);
        vm.prank(lender);
        lending.supply(market, 50 ether, 0, lender, "");

        _fundWrapped(trader, 50 ether);
        uint256 bought = _buy(trader, token, 20 ether);

        vm.startPrank(trader);
        IERC20(token).approve(address(lending), type(uint256).max);
        lending.supplyCollateral(market, bought, trader, "");
        vm.expectRevert(abi.encodeWithSelector(V3TwapOracle.HistoryTooShort.selector, uint32(0), uint32(10 minutes)));
        lending.borrow(market, 1 ether, 0, trader, trader);
        vm.stopPrank();

        skip(15 minutes);

        // Collateral bought for 20 CYBER is worth somewhat less at the averaged price; half of it
        // can be borrowed.
        vm.prank(trader);
        lending.borrow(market, 5 ether, 0, trader, trader);
        assertEq(wcyber.balanceOf(trader), 35 ether);
    }

    function test_holdersCanLendTheTokenOut() public {
        address token = _launch(launchpad.KIT_CREDIT());
        Launchpad.Economy memory e = launchpad.economyOf(token);
        MarketParams memory shortMarket = MarketParams(token, address(wcyber), e.cyberOracle, address(irm), LAUNCH_LLTV);

        _fundWrapped(trader, 50 ether);
        uint256 bought = _buy(trader, token, 20 ether);
        vm.startPrank(trader);
        IERC20(token).approve(address(lending), type(uint256).max);
        lending.supply(shortMarket, bought, 0, trader, "");
        vm.stopPrank();

        skip(15 minutes);

        // A bear posts CYBER and borrows the token, to sell it.
        address bear = makeAddr("bear");
        _fundWrapped(bear, 10 ether);
        vm.startPrank(bear);
        lending.supplyCollateral(shortMarket, 10 ether, bear, "");
        lending.borrow(shortMarket, bought / 10, 0, bear, bear);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(bear), bought / 10);

        skip(30 days);
        lending.accrueInterest(shortMarket);
        (uint128 supplied,,,,,) = lending.market(e.borrowTokenMarket);
        assertGt(supplied, bought, "the holder's supply earned interest in the token");
    }

    // ------------------------------------------------------------------------------- liquidity

    function test_vaultSharesEarnTheFees() public {
        address token = _launch(0);
        Launchpad.Economy memory e = launchpad.economyOf(token);
        LiquidityVault vault = LiquidityVault(e.vault);

        _fundWrapped(lp, 100 ether);
        _fundWrapped(trader, 100 ether);
        uint256 lpTokens = _buy(lp, token, 10 ether);

        vm.startPrank(lp);
        IERC20(token).approve(address(vault), type(uint256).max);
        wcyber.approve(address(vault), type(uint256).max);
        (uint256 max0, uint256 max1) = _balances(lp, token);
        (uint256 shares, uint256 used0, uint256 used1) = vault.deposit(max0, max1, 1, lp);
        vm.stopPrank();
        assertGt(shares, 0);
        // A full-range deposit takes both sides; one of them is bounded by what the LP holds.
        assertTrue(used0 > 0 && used1 > 0);
        assertLe(token < address(wcyber) ? used0 : used1, lpTokens);

        // Volume through the pool, round trip.
        for (uint256 i = 0; i < 5; i++) {
            uint256 got = _buy(trader, token, 5 ether);
            _sell(trader, token, got);
        }
        vault.compound();

        vm.prank(lp);
        (uint256 out0, uint256 out1) = vault.withdraw(shares, 0, 0, lp);
        (uint256 inCyber, uint256 outCyber) = token < address(wcyber) ? (used1, out1) : (used0, out0);
        (uint256 inToken, uint256 outToken) = token < address(wcyber) ? (used0, out0) : (used1, out1);

        // After round trips the price is back near where it was, so both sides should have grown.
        assertGt(outCyber + _valueInCyber(token, outToken), inCyber + _valueInCyber(token, inToken));
    }

    function _balances(address who, address token) internal view returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = token < address(wcyber)
            ? (IERC20(token).balanceOf(who), wcyber.balanceOf(who))
            : (wcyber.balanceOf(who), IERC20(token).balanceOf(who));
    }

    function _valueInCyber(address token, uint256 amount) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IV3Pool(launchpad.economyOf(token).pool).slot0();
        uint256 priceX96 = uint256(sqrtPriceX96) * sqrtPriceX96 >> 96; // token1 per token0, Q96
        return token < address(wcyber) ? amount * priceX96 >> 96 : (amount << 96) / priceX96;
    }

    function test_vaultFirstDepositLocksMinimumShares() public {
        address token = _launch(0);
        LiquidityVault vault = LiquidityVault(launchpad.economyOf(token).vault);

        _fundWrapped(lp, 10 ether);
        _buy(lp, token, 1 ether);
        vm.startPrank(lp);
        IERC20(token).approve(address(vault), type(uint256).max);
        wcyber.approve(address(vault), type(uint256).max);
        (uint256 max0, uint256 max1) = _balances(lp, token);
        vault.deposit(max0, max1, 1, lp);
        vm.stopPrank();

        assertEq(vault.balanceOf(vault.BURN()), vault.MINIMUM_SHARES());
    }
}
