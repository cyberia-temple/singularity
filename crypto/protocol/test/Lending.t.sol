// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";

import {Lending} from "../contracts/lending/Lending.sol";
import {AdaptiveCurveIrm} from "../contracts/lending/irm/AdaptiveCurveIrm.sol";
import {
    Id,
    ILending,
    MarketParams,
    Authorization,
    Signature
} from "../contracts/lending/interfaces/ILending.sol";
import {ILendingFlashLoanCallback, ILendingLiquidateCallback} from "../contracts/lending/interfaces/ILendingCallbacks.sol";
import {MarketParamsLib} from "../contracts/lending/MarketParamsLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockOracle} from "./mocks/MockOracle.sol";

contract FlashBorrower is ILendingFlashLoanCallback {
    Lending immutable lending;
    MockERC20 immutable token;
    uint256 public seen;

    constructor(Lending lending_, MockERC20 token_) {
        lending = lending_;
        token = token_;
    }

    function run(uint256 assets) external {
        lending.flashLoan(address(token), assets, "");
    }

    function onLendingFlashLoan(uint256 assets, bytes calldata) external {
        seen = token.balanceOf(address(this));
        token.approve(address(lending), assets);
    }
}

/// Liquidates without holding any loan token: sells nothing, just shows the callback runs between
/// receiving collateral and paying the debt.
contract CallbackLiquidator is ILendingLiquidateCallback {
    Lending immutable lending;
    MockERC20 immutable loan;
    MockERC20 immutable collateral;
    uint256 public collateralSeenInCallback;

    constructor(Lending lending_, MockERC20 loan_, MockERC20 collateral_) {
        lending = lending_;
        loan = loan_;
        collateral = collateral_;
    }

    function run(MarketParams memory params, address borrower, uint256 seize) external {
        lending.liquidate(params, borrower, seize, 0, hex"01");
    }

    function onLendingLiquidate(uint256 repaidAssets, bytes calldata) external {
        collateralSeenInCallback = collateral.balanceOf(address(this));
        // Stands in for selling the seized collateral.
        loan.mint(address(this), repaidAssets);
        loan.approve(address(lending), repaidAssets);
    }
}

contract LendingTest is Test {
    using MarketParamsLib for MarketParams;

    uint256 constant LLTV = 0.8e18;
    uint256 constant PRICE_ONE = 1e36;

    AccessManager authority;
    Lending lending;
    AdaptiveCurveIrm irm;
    MockERC20 loan;
    MockERC20 collateral;
    MockOracle oracle;
    MarketParams params;
    Id id;

    address feeRecipient = makeAddr("feeRecipient");
    address supplier = makeAddr("supplier");
    address borrower = makeAddr("borrower");
    address liquidator = makeAddr("liquidator");

    function setUp() public {
        authority = new AccessManager(address(this));
        lending = new Lending(address(authority), feeRecipient);
        irm = new AdaptiveCurveIrm(address(lending));

        lending.enableIrm(address(irm));
        lending.enableIrm(address(0));
        lending.enableLltv(LLTV);

        loan = new MockERC20("Loan", "LOAN", 18);
        collateral = new MockERC20("Collateral", "COLL", 18);
        oracle = new MockOracle();
        oracle.setPrice(PRICE_ONE);

        params = MarketParams({
            loanToken: address(loan),
            collateralToken: address(collateral),
            oracle: address(oracle),
            irm: address(irm),
            lltv: LLTV
        });
        id = params.id();
        lending.createMarket(params);

        for (uint256 i = 0; i < 3; i++) {
            address who = [supplier, borrower, liquidator][i];
            vm.startPrank(who);
            loan.approve(address(lending), type(uint256).max);
            collateral.approve(address(lending), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------------------- helpers

    function _supply(uint256 assets) internal {
        loan.mint(supplier, assets);
        vm.prank(supplier);
        lending.supply(params, assets, 0, supplier, "");
    }

    function _collateralize(uint256 assets) internal {
        collateral.mint(borrower, assets);
        vm.prank(borrower);
        lending.supplyCollateral(params, assets, borrower, "");
    }

    function _borrow(uint256 assets) internal {
        vm.prank(borrower);
        lending.borrow(params, assets, 0, borrower, borrower);
    }

    function _totals()
        internal
        view
        returns (uint256 supplyAssets, uint256 supplyShares, uint256 borrowAssets, uint256 borrowShares)
    {
        (uint128 a, uint128 b, uint128 c, uint128 d,,) = lending.market(id);
        return (a, b, c, d);
    }

    // ----------------------------------------------------------------------------- governance

    function test_governanceIsRestricted() public {
        vm.startPrank(supplier);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, supplier));
        lending.enableLltv(0.5e18);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, supplier));
        lending.setFeeRecipient(supplier);
        vm.stopPrank();
    }

    function test_lltvMustBeBelowOne() public {
        vm.expectRevert(ILending.MaxLltvExceeded.selector);
        lending.enableLltv(1e18);
    }

    function test_marketNeedsEnabledParams() public {
        MarketParams memory p = params;
        p.lltv = 0.5e18;
        vm.expectRevert(ILending.LltvNotEnabled.selector);
        lending.createMarket(p);

        p.lltv = LLTV;
        p.irm = address(0xBEEF);
        vm.expectRevert(ILending.IrmNotEnabled.selector);
        lending.createMarket(p);

        vm.expectRevert(ILending.MarketAlreadyCreated.selector);
        lending.createMarket(params);
    }

    function test_feeIsCapped() public {
        vm.expectRevert(ILending.MaxFeeExceeded.selector);
        lending.setFee(params, 0.25e18 + 1);
    }

    // ------------------------------------------------------------------------- supply/withdraw

    function test_supplyAndWithdrawRoundTrip() public {
        _supply(1000e18);
        (uint256 shares,,) = lending.position(id, supplier);
        assertEq(shares, 1000e18 * 1e6, "virtual offset scales shares by 1e6");

        vm.prank(supplier);
        lending.withdraw(params, 0, shares, supplier, supplier);
        assertEq(loan.balanceOf(supplier), 1000e18);
    }

    function test_withdrawOnBehalfNeedsAuthorization() public {
        _supply(10e18);
        vm.prank(borrower);
        vm.expectRevert(ILending.Unauthorized.selector);
        lending.withdraw(params, 1e18, 0, supplier, borrower);
    }

    function test_donationDoesNotInflateShares() public {
        // The first depositor "donates" a large balance straight to the contract. The book counts
        // what was supplied through it, never its own balance, so the donation buys nothing.
        _supply(1);
        loan.mint(address(lending), 1_000_000e18);

        address victim = makeAddr("victim");
        loan.mint(victim, 100e18);
        vm.startPrank(victim);
        loan.approve(address(lending), type(uint256).max);
        (, uint256 shares) = lending.supply(params, 100e18, 0, victim, "");
        assertGt(shares, 0);
        (uint256 assetsBack,) = lending.withdraw(params, 0, shares, victim, victim);
        vm.stopPrank();

        assertEq(assetsBack, 100e18, "victim gets every wei back");
    }

    // ------------------------------------------------------------------------------- borrowing

    function test_borrowNeedsCollateral() public {
        _supply(100e18);
        vm.prank(borrower);
        vm.expectRevert(ILending.InsufficientCollateral.selector);
        lending.borrow(params, 1, 0, borrower, borrower);
    }

    function test_borrowUpToLltv() public {
        _supply(100e18);
        _collateralize(100e18);

        _borrow(80e18);
        assertEq(loan.balanceOf(borrower), 80e18);

        vm.prank(borrower);
        vm.expectRevert(ILending.InsufficientCollateral.selector);
        lending.borrow(params, 1, 0, borrower, borrower);
    }

    function test_borrowNeedsLiquidity() public {
        _supply(10e18);
        _collateralize(100e18);

        vm.prank(borrower);
        vm.expectRevert(ILending.InsufficientLiquidity.selector);
        lending.borrow(params, 11e18, 0, borrower, borrower);
    }

    /// The hole in the old Compound-style markets: collateral that could be moved away while a
    /// loan stood against it. Here a position is not a token, and the only way to take collateral
    /// out is `withdrawCollateral`, which checks health first.
    function test_collateralCannotLeaveWhileItSecuresDebt() public {
        _supply(100e18);
        _collateralize(100e18);
        _borrow(50e18);

        vm.prank(borrower);
        vm.expectRevert(ILending.InsufficientCollateral.selector);
        lending.withdrawCollateral(params, 50e18, borrower, borrower);

        vm.prank(borrower);
        lending.withdrawCollateral(params, 37.5e18, borrower, borrower);
    }

    function test_repayInFull() public {
        _supply(100e18);
        _collateralize(100e18);
        _borrow(50e18);

        skip(30 days);

        (, uint128 borrowShares,) = lending.position(id, borrower);
        loan.mint(borrower, 10e18); // to cover interest
        vm.prank(borrower);
        (uint256 repaid,) = lending.repay(params, 0, borrowShares, borrower, "");
        assertGt(repaid, 50e18, "interest accrued over a month");

        (, uint128 after_,) = lending.position(id, borrower);
        assertEq(after_, 0);

        vm.prank(borrower);
        lending.withdrawCollateral(params, 100e18, borrower, borrower);
    }

    // -------------------------------------------------------------------------------- interest

    function test_interestAccruesToSuppliersAndFee() public {
        lending.setFee(params, 0.1e18);
        _supply(100e18);
        _collateralize(200e18);
        _borrow(90e18);

        skip(365 days);
        lending.accrueInterest(params);

        (uint256 supplyAssets,, uint256 borrowAssets,) = _totals();
        uint256 interest = borrowAssets - 90e18;
        assertGt(interest, 0);
        assertEq(supplyAssets, 100e18 + interest, "suppliers' total grows by exactly the interest");

        (uint256 feeShares,,) = lending.position(id, feeRecipient);
        assertGt(feeShares, 0, "the fee recipient earned shares");
    }

    function test_noIrmMeansNoInterest() public {
        MarketParams memory p = params;
        p.irm = address(0);
        lending.createMarket(p);
        Id freeId = p.id();

        loan.mint(supplier, 100e18);
        vm.prank(supplier);
        lending.supply(p, 100e18, 0, supplier, "");
        collateral.mint(borrower, 100e18);
        vm.startPrank(borrower);
        lending.supplyCollateral(p, 100e18, borrower, "");
        lending.borrow(p, 50e18, 0, borrower, borrower);
        vm.stopPrank();

        skip(365 days);
        lending.accrueInterest(p);
        (,, uint128 borrowAssets,,,) = lending.market(freeId);
        assertEq(borrowAssets, 50e18);
    }

    // ----------------------------------------------------------------------------- liquidation

    function test_cannotLiquidateHealthy() public {
        _supply(100e18);
        _collateralize(100e18);
        _borrow(80e18);

        vm.prank(liquidator);
        vm.expectRevert(ILending.HealthyPosition.selector);
        lending.liquidate(params, borrower, 1e18, 0, "");
    }

    function test_liquidationPaysIncentive() public {
        _supply(100e18);
        _collateralize(100e18);
        _borrow(80e18);

        oracle.setPrice(0.9e36); // collateral worth 90, LLTV 80% → may borrow 72, owes 80

        loan.mint(liquidator, 100e18);
        vm.prank(liquidator);
        (uint256 seized, uint256 repaid) = lending.liquidate(params, borrower, 50e18, 0, "");

        assertEq(seized, 50e18);
        // Incentive at LLTV 0.8: 1 / (1 - 0.3 · 0.2) = 1.0638…
        uint256 valueSeized = seized * 9 / 10;
        assertApproxEqRel(valueSeized * 1e18 / repaid, 1.0638e18, 0.001e18);
        assertEq(collateral.balanceOf(liquidator), 50e18);
    }

    function test_badDebtIsWrittenOffAgainstSuppliers() public {
        _supply(100e18);
        _collateralize(100e18);
        _borrow(80e18);

        oracle.setPrice(0.5e36); // collateral worth 50 against 80 of debt

        loan.mint(liquidator, 100e18);
        vm.prank(liquidator);
        lending.liquidate(params, borrower, 100e18, 0, "");

        (, uint128 borrowShares, uint128 coll) = lending.position(id, borrower);
        assertEq(coll, 0);
        assertEq(borrowShares, 0, "remaining debt written off");

        (uint256 supplyAssets,, uint256 borrowAssets,) = _totals();
        assertEq(borrowAssets, 0);
        assertLt(supplyAssets, 100e18, "suppliers absorbed the loss");
        assertApproxEqAbs(loan.balanceOf(address(lending)), supplyAssets, 1, "book matches cash");
    }

    function test_liquidationCallbackRunsBeforePayment() public {
        _supply(100e18);
        _collateralize(100e18);
        _borrow(80e18);
        oracle.setPrice(0.9e36);

        CallbackLiquidator bot = new CallbackLiquidator(lending, loan, collateral);
        bot.run(params, borrower, 40e18);
        assertEq(bot.collateralSeenInCallback(), 40e18, "collateral arrives before the debt is pulled");
    }

    // ----------------------------------------------------------------------------- flash loans

    function test_flashLoanMustBeRepaid() public {
        _supply(100e18);
        FlashBorrower fb = new FlashBorrower(lending, loan);
        fb.run(60e18);
        assertEq(fb.seen(), 60e18);
        assertEq(loan.balanceOf(address(lending)), 100e18);
    }

    // --------------------------------------------------------------------------- authorization

    function test_authorizationBySignature() public {
        (address owner_, uint256 key) = makeAddrAndKey("owner");
        address operator = makeAddr("operator");

        Authorization memory auth = Authorization({
            authorizer: owner_,
            authorized: operator,
            isAuthorized: true,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                lending.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(lending.AUTHORIZATION_TYPEHASH(), auth))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        lending.setAuthorizationWithSig(auth, Signature(v, r, s));
        assertTrue(lending.isAuthorized(owner_, operator));

        vm.expectRevert(ILending.InvalidNonce.selector);
        lending.setAuthorizationWithSig(auth, Signature(v, r, s));
    }

    // ------------------------------------------------------------------------------------ fuzz

    /// Whatever goes in, nobody gets more out than they put in, and the book never promises more
    /// than it holds.
    function testFuzz_supplyWithdrawNeverProfits(uint256 first, uint256 second) public {
        first = bound(first, 1, 1e30);
        second = bound(second, 1, 1e30);

        _supply(first);

        address other = makeAddr("other");
        loan.mint(other, second);
        vm.startPrank(other);
        loan.approve(address(lending), type(uint256).max);
        (, uint256 shares) = lending.supply(params, second, 0, other, "");
        (uint256 back,) = lending.withdraw(params, 0, shares, other, other);
        vm.stopPrank();

        assertLe(back, second);
        (uint256 supplyAssets,,,) = _totals();
        assertLe(supplyAssets, loan.balanceOf(address(lending)));
    }

    function testFuzz_borrowRepayLeavesNoDebt(uint256 amount, uint256 elapsed) public {
        amount = bound(amount, 1e6, 1e27);
        elapsed = bound(elapsed, 0, 3 * 365 days);

        _supply(amount * 2);
        _collateralize(amount * 2);
        _borrow(amount);

        skip(elapsed);

        (, uint128 borrowShares,) = lending.position(id, borrower);
        loan.mint(borrower, amount * 10);
        vm.prank(borrower);
        lending.repay(params, 0, borrowShares, borrower, "");

        (uint256 supplyAssets,, uint256 borrowAssets,) = _totals();
        assertEq(borrowAssets, 0);
        assertLe(supplyAssets, loan.balanceOf(address(lending)), "every supplied asset is backed");
    }
}
