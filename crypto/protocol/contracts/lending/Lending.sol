// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {
    Id,
    ILending,
    MarketParams,
    Position,
    Market,
    Authorization,
    Signature
} from "./interfaces/ILending.sol";
import {IIrm} from "./interfaces/IIrm.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {
    ILendingSupplyCallback,
    ILendingRepayCallback,
    ILendingSupplyCollateralCallback,
    ILendingLiquidateCallback,
    ILendingFlashLoanCallback
} from "./interfaces/ILendingCallbacks.sol";
import {MarketParamsLib} from "./MarketParamsLib.sol";
import {MathLib, WAD} from "../libraries/MathLib.sol";
import {SharesMath} from "../libraries/SharesMath.sol";
import {UtilsLib} from "../libraries/UtilsLib.sol";

/// @title Lending -- one book of isolated lending markets
/// @notice A market is five parameters and nothing else: what is lent, what secures it, who prices
/// it, how interest moves, and at what loan-to-value a position may be liquidated. Anyone may open
/// one for any pair, so a token launched on Cyberia can be borrowed against, and lent out, the
/// moment it exists -- and a bad market harms only the people who chose to supply into it.
///
/// @dev The design is Morpho Blue's: one contract holds every market, positions are kept in shares
/// with a virtual offset, interest compounds per second, liquidation pays an incentive that grows
/// as the LLTV falls, and a position left with debt and no collateral is written off against that
/// market's suppliers on the spot rather than lingering as phantom solvency. What governance
/// controls is deliberately narrow: which rate models and LLTVs may be used, and a fee on interest
/// of at most 25%. It can never touch a position, price a market, pause one, or move funds.
///
/// Tokens are assumed to be standard ERC-20s. Fee-on-transfer and rebasing tokens break the
/// accounting of every market they are in and nothing here tries to detect them.
contract Lending is ILending, AccessManaged, EIP712 {
    using MathLib for uint256;
    using SharesMath for uint256;
    using UtilsLib for uint256;
    using MarketParamsLib for MarketParams;
    using SafeERC20 for IERC20;

    /// @notice The most governance may take from interest, in WAD
    uint256 public constant MAX_FEE = 0.25e18;

    /// @notice Scale of every oracle price
    uint256 public constant ORACLE_PRICE_SCALE = 1e36;

    /// @notice Shapes the liquidation incentive: 1 / (1 − cursor · (1 − lltv))
    uint256 public constant LIQUIDATION_CURSOR = 0.3e18;

    /// @notice The incentive never exceeds 15%, however low the LLTV
    uint256 public constant MAX_LIQUIDATION_INCENTIVE_FACTOR = 1.15e18;

    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
    );

    /// @inheritdoc ILending
    address public feeRecipient;

    mapping(Id => mapping(address => Position)) public position;
    mapping(Id => Market) public market;
    mapping(Id => MarketParams) public idToMarketParams;

    mapping(address => bool) public isIrmEnabled;
    mapping(uint256 => bool) public isLltvEnabled;

    mapping(address => mapping(address => bool)) public isAuthorized;
    mapping(address => uint256) public nonce;

    constructor(address authority, address initialFeeRecipient) AccessManaged(authority) EIP712("Cyberia Lending", "1") {
        feeRecipient = initialFeeRecipient;
        emit SetFeeRecipient(initialFeeRecipient);
    }

    // ---------------------------------------------------------------------------------- governance

    /// @notice Allow markets to use `irm`. There is no way to disallow one again: markets already
    /// using it would have no rate model left to call.
    function enableIrm(address irm) external restricted {
        if (isIrmEnabled[irm]) revert AlreadySet();
        isIrmEnabled[irm] = true;
        emit EnableIrm(irm);
    }

    /// @notice Allow markets to use `lltv`. Like rate models, an LLTV once allowed stays allowed.
    function enableLltv(uint256 lltv) external restricted {
        if (isLltvEnabled[lltv]) revert AlreadySet();
        if (lltv >= WAD) revert MaxLltvExceeded();
        isLltvEnabled[lltv] = true;
        emit EnableLltv(lltv);
    }

    function setFee(MarketParams memory marketParams, uint256 newFee) external restricted {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (newFee == market[id].fee) revert AlreadySet();
        if (newFee > MAX_FEE) revert MaxFeeExceeded();

        // Interest already earned is charged at the fee it was earned under.
        _accrueInterest(marketParams, id);

        market[id].fee = uint128(newFee);
        emit SetFee(id, newFee);
    }

    function setFeeRecipient(address newFeeRecipient) external restricted {
        if (newFeeRecipient == feeRecipient) revert AlreadySet();
        feeRecipient = newFeeRecipient;
        emit SetFeeRecipient(newFeeRecipient);
    }

    // ------------------------------------------------------------------------------------- markets

    function createMarket(MarketParams memory marketParams) external {
        Id id = marketParams.id();
        if (!isIrmEnabled[marketParams.irm]) revert IrmNotEnabled();
        if (!isLltvEnabled[marketParams.lltv]) revert LltvNotEnabled();
        if (market[id].lastUpdate != 0) revert MarketAlreadyCreated();

        market[id].lastUpdate = uint128(block.timestamp);
        idToMarketParams[id] = marketParams;

        emit CreateMarket(id, marketParams);

        // A stateful model gets to set itself up for the market now, so its first real rate is
        // computed from a known starting point rather than from whenever somebody first borrowed.
        if (marketParams.irm != address(0)) IIrm(marketParams.irm).borrowRate(marketParams, market[id]);
    }

    // ---------------------------------------------------------------------------- supply / withdraw

    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata data
    ) external returns (uint256, uint256) {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (!UtilsLib.exactlyOneZero(assets, shares)) revert InconsistentInput();
        if (onBehalf == address(0)) revert ZeroAddress();

        _accrueInterest(marketParams, id);

        if (assets > 0) shares = assets.toSharesDown(market[id].totalSupplyAssets, market[id].totalSupplyShares);
        else assets = shares.toAssetsUp(market[id].totalSupplyAssets, market[id].totalSupplyShares);

        position[id][onBehalf].supplyShares += shares;
        market[id].totalSupplyShares += shares.toUint128();
        market[id].totalSupplyAssets += assets.toUint128();

        emit Supply(id, msg.sender, onBehalf, assets, shares);

        if (data.length > 0) ILendingSupplyCallback(msg.sender).onLendingSupply(assets, data);

        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), assets);

        return (assets, shares);
    }

    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256) {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (!UtilsLib.exactlyOneZero(assets, shares)) revert InconsistentInput();
        if (receiver == address(0)) revert ZeroAddress();
        if (!_isSenderAuthorized(onBehalf)) revert Unauthorized();

        _accrueInterest(marketParams, id);

        if (assets > 0) shares = assets.toSharesUp(market[id].totalSupplyAssets, market[id].totalSupplyShares);
        else assets = shares.toAssetsDown(market[id].totalSupplyAssets, market[id].totalSupplyShares);

        position[id][onBehalf].supplyShares -= shares;
        market[id].totalSupplyShares -= shares.toUint128();
        market[id].totalSupplyAssets -= assets.toUint128();

        if (market[id].totalBorrowAssets > market[id].totalSupplyAssets) revert InsufficientLiquidity();

        emit Withdraw(id, msg.sender, onBehalf, receiver, assets, shares);

        IERC20(marketParams.loanToken).safeTransfer(receiver, assets);

        return (assets, shares);
    }

    // ------------------------------------------------------------------------------ borrow / repay

    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256) {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (!UtilsLib.exactlyOneZero(assets, shares)) revert InconsistentInput();
        if (receiver == address(0)) revert ZeroAddress();
        if (!_isSenderAuthorized(onBehalf)) revert Unauthorized();

        _accrueInterest(marketParams, id);

        if (assets > 0) shares = assets.toSharesUp(market[id].totalBorrowAssets, market[id].totalBorrowShares);
        else assets = shares.toAssetsDown(market[id].totalBorrowAssets, market[id].totalBorrowShares);

        position[id][onBehalf].borrowShares += shares.toUint128();
        market[id].totalBorrowShares += shares.toUint128();
        market[id].totalBorrowAssets += assets.toUint128();

        if (!_isHealthy(marketParams, id, onBehalf)) revert InsufficientCollateral();
        if (market[id].totalBorrowAssets > market[id].totalSupplyAssets) revert InsufficientLiquidity();

        emit Borrow(id, msg.sender, onBehalf, receiver, assets, shares);

        IERC20(marketParams.loanToken).safeTransfer(receiver, assets);

        return (assets, shares);
    }

    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata data
    ) external returns (uint256, uint256) {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (!UtilsLib.exactlyOneZero(assets, shares)) revert InconsistentInput();
        if (onBehalf == address(0)) revert ZeroAddress();

        _accrueInterest(marketParams, id);

        if (assets > 0) shares = assets.toSharesDown(market[id].totalBorrowAssets, market[id].totalBorrowShares);
        else assets = shares.toAssetsUp(market[id].totalBorrowAssets, market[id].totalBorrowShares);

        position[id][onBehalf].borrowShares -= shares.toUint128();
        market[id].totalBorrowShares -= shares.toUint128();
        // Rounding the debt up and the repayment down can leave the total a wei short of the sum of
        // what is owed; flooring at zero keeps the last repayment of a market from reverting.
        market[id].totalBorrowAssets = UtilsLib.zeroFloorSub(market[id].totalBorrowAssets, assets).toUint128();

        emit Repay(id, msg.sender, onBehalf, assets, shares);

        if (data.length > 0) ILendingRepayCallback(msg.sender).onLendingRepay(assets, data);

        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), assets);

        return (assets, shares);
    }

    // -------------------------------------------------------------------------------- collateral

    /// @dev No accrual: collateral earns nothing and owes nothing, and adding it can only help.
    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes calldata data)
        external
    {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (assets == 0) revert ZeroAssets();
        if (onBehalf == address(0)) revert ZeroAddress();

        position[id][onBehalf].collateral += assets.toUint128();

        emit SupplyCollateral(id, msg.sender, onBehalf, assets);

        if (data.length > 0) ILendingSupplyCollateralCallback(msg.sender).onLendingSupplyCollateral(assets, data);

        IERC20(marketParams.collateralToken).safeTransferFrom(msg.sender, address(this), assets);
    }

    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external
    {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (assets == 0) revert ZeroAssets();
        if (receiver == address(0)) revert ZeroAddress();
        if (!_isSenderAuthorized(onBehalf)) revert Unauthorized();

        _accrueInterest(marketParams, id);

        position[id][onBehalf].collateral -= assets.toUint128();

        if (!_isHealthy(marketParams, id, onBehalf)) revert InsufficientCollateral();

        emit WithdrawCollateral(id, msg.sender, onBehalf, receiver, assets);

        IERC20(marketParams.collateralToken).safeTransfer(receiver, assets);
    }

    // ------------------------------------------------------------------------------- liquidation

    /// @notice Repay part of an unhealthy position's debt and take its collateral at a discount
    /// @param seizedAssets Collateral to take; or zero, with `repaidShares` saying how much debt to
    /// repay instead
    /// @dev There is no close factor: a position is either healthy or open to being closed in full,
    /// which is what makes liquidating small positions worth anybody's gas.
    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256, uint256) {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (!UtilsLib.exactlyOneZero(seizedAssets, repaidShares)) revert InconsistentInput();

        _accrueInterest(marketParams, id);

        {
            uint256 collateralPrice = IOracle(marketParams.oracle).price();

            if (_isHealthy(marketParams, id, borrower, collateralPrice)) revert HealthyPosition();

            uint256 incentiveFactor = UtilsLib.min(
                MAX_LIQUIDATION_INCENTIVE_FACTOR,
                WAD.wDivDown(WAD - LIQUIDATION_CURSOR.wMulDown(WAD - marketParams.lltv))
            );

            if (seizedAssets > 0) {
                uint256 seizedAssetsQuoted = seizedAssets.mulDivUp(collateralPrice, ORACLE_PRICE_SCALE);

                repaidShares = seizedAssetsQuoted.wDivUp(incentiveFactor).toSharesUp(
                    market[id].totalBorrowAssets, market[id].totalBorrowShares
                );
            } else {
                seizedAssets = repaidShares.toAssetsDown(market[id].totalBorrowAssets, market[id].totalBorrowShares)
                    .wMulDown(incentiveFactor).mulDivDown(ORACLE_PRICE_SCALE, collateralPrice);
            }
        }

        uint256 repaidAssets = repaidShares.toAssetsUp(market[id].totalBorrowAssets, market[id].totalBorrowShares);

        position[id][borrower].borrowShares -= repaidShares.toUint128();
        market[id].totalBorrowShares -= repaidShares.toUint128();
        market[id].totalBorrowAssets = UtilsLib.zeroFloorSub(market[id].totalBorrowAssets, repaidAssets).toUint128();

        position[id][borrower].collateral -= seizedAssets.toUint128();

        uint256 badDebtShares;
        uint256 badDebtAssets;
        if (position[id][borrower].collateral == 0) {
            // Nothing is left to secure what is still owed. Writing it off now, against this
            // market's suppliers only, keeps every reader of the book seeing what the market is
            // actually worth instead of a debt that will never be repaid.
            badDebtShares = position[id][borrower].borrowShares;
            badDebtAssets = UtilsLib.min(
                market[id].totalBorrowAssets,
                badDebtShares.toAssetsUp(market[id].totalBorrowAssets, market[id].totalBorrowShares)
            );

            market[id].totalBorrowAssets -= badDebtAssets.toUint128();
            market[id].totalSupplyAssets -= badDebtAssets.toUint128();
            market[id].totalBorrowShares -= badDebtShares.toUint128();
            position[id][borrower].borrowShares = 0;
        }

        emit Liquidate(id, msg.sender, borrower, repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares);

        IERC20(marketParams.collateralToken).safeTransfer(msg.sender, seizedAssets);

        if (data.length > 0) ILendingLiquidateCallback(msg.sender).onLendingLiquidate(repaidAssets, data);

        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), repaidAssets);

        return (seizedAssets, repaidAssets);
    }

    // -------------------------------------------------------------------------------- flash loans

    /// @notice Borrow anything the book holds -- every market's cash and every position's
    /// collateral -- for the length of one call, for free
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        if (assets == 0) revert ZeroAssets();

        emit FlashLoan(msg.sender, token, assets);

        IERC20(token).safeTransfer(msg.sender, assets);

        ILendingFlashLoanCallback(msg.sender).onLendingFlashLoan(assets, data);

        IERC20(token).safeTransferFrom(msg.sender, address(this), assets);
    }

    // ----------------------------------------------------------------------------- authorization

    /// @notice Let `authorized` withdraw, borrow and remove collateral on the caller's behalf
    /// @dev What a bundler, a vault or a leverage router needs. Supplying and repaying never need
    /// it: anyone may add to someone else's position.
    function setAuthorization(address authorized, bool newIsAuthorized) external {
        if (newIsAuthorized == isAuthorized[msg.sender][authorized]) revert AlreadySet();

        isAuthorized[msg.sender][authorized] = newIsAuthorized;

        emit SetAuthorization(msg.sender, msg.sender, authorized, newIsAuthorized);
    }

    /// @notice The same grant, signed off-chain (EIP-712) so it can ride inside another transaction
    function setAuthorizationWithSig(Authorization calldata authorization, Signature calldata signature) external {
        if (block.timestamp > authorization.deadline) revert SignatureExpired();
        if (authorization.nonce != nonce[authorization.authorizer]++) revert InvalidNonce();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(AUTHORIZATION_TYPEHASH, authorization)));
        (address signatory, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature.v, signature.r, signature.s);
        if (err != ECDSA.RecoverError.NoError || signatory != authorization.authorizer) revert InvalidSignature();

        emit IncrementNonce(msg.sender, authorization.authorizer, authorization.nonce);

        isAuthorized[authorization.authorizer][authorization.authorized] = authorization.isAuthorized;

        emit SetAuthorization(
            msg.sender, authorization.authorizer, authorization.authorized, authorization.isAuthorized
        );
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _isSenderAuthorized(address onBehalf) internal view returns (bool) {
        return msg.sender == onBehalf || isAuthorized[onBehalf][msg.sender];
    }

    // ---------------------------------------------------------------------------------- interest

    function accrueInterest(MarketParams memory marketParams) external {
        Id id = marketParams.id();
        if (market[id].lastUpdate == 0) revert MarketNotCreated();

        _accrueInterest(marketParams, id);
    }

    function _accrueInterest(MarketParams memory marketParams, Id id) internal {
        uint256 elapsed = block.timestamp - market[id].lastUpdate;
        if (elapsed == 0) return;

        if (marketParams.irm != address(0)) {
            uint256 borrowRate = IIrm(marketParams.irm).borrowRate(marketParams, market[id]);
            uint256 interest = uint256(market[id].totalBorrowAssets).wMulDown(borrowRate.wTaylorCompounded(elapsed));
            market[id].totalBorrowAssets += interest.toUint128();
            market[id].totalSupplyAssets += interest.toUint128();

            uint256 feeShares;
            if (market[id].fee != 0) {
                uint256 feeAmount = interest.wMulDown(market[id].fee);
                // The fee is new supply, priced as if it had been deposited after the interest
                // landed, so it dilutes suppliers by exactly the fee and no more.
                feeShares =
                    feeAmount.toSharesDown(market[id].totalSupplyAssets - feeAmount, market[id].totalSupplyShares);
                position[id][feeRecipient].supplyShares += feeShares;
                market[id].totalSupplyShares += feeShares.toUint128();
            }

            emit AccrueInterest(id, borrowRate, interest, feeShares);
        }

        market[id].lastUpdate = uint128(block.timestamp);
    }

    // ------------------------------------------------------------------------------------ health

    function _isHealthy(MarketParams memory marketParams, Id id, address borrower) internal view returns (bool) {
        // No debt, nothing to price: a lender or an idle depositor never depends on the oracle.
        if (position[id][borrower].borrowShares == 0) return true;

        return _isHealthy(marketParams, id, borrower, IOracle(marketParams.oracle).price());
    }

    function _isHealthy(MarketParams memory marketParams, Id id, address borrower, uint256 collateralPrice)
        internal
        view
        returns (bool)
    {
        uint256 borrowed = uint256(position[id][borrower].borrowShares).toAssetsUp(
            market[id].totalBorrowAssets, market[id].totalBorrowShares
        );
        uint256 maxBorrow = uint256(position[id][borrower].collateral).mulDivDown(collateralPrice, ORACLE_PRICE_SCALE)
            .wMulDown(marketParams.lltv);

        return maxBorrow >= borrowed;
    }
}
