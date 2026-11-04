// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

type Id is bytes32;

/// @notice Everything that defines a market. Two markets differ exactly when one of these does.
/// @param loanToken What suppliers lend and borrowers owe
/// @param collateralToken What borrowers post
/// @param oracle Price of one collateral unit in loan units, scaled by 1e36 (see `IOracle`)
/// @param irm The interest rate model; zero means the market charges no interest
/// @param lltv Liquidation loan-to-value, in WAD: a position whose debt exceeds this share of its
/// collateral's value may be liquidated
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct Position {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

/// @dev `totalSupplyAssets` and `totalBorrowAssets` include interest accrued up to `lastUpdate`.
/// `fee` is the share of interest minted to the fee recipient, in WAD.
struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

struct Authorization {
    address authorizer;
    address authorized;
    bool isAuthorized;
    uint256 nonce;
    uint256 deadline;
}

struct Signature {
    uint8 v;
    bytes32 r;
    bytes32 s;
}

interface ILending {
    event CreateMarket(Id indexed id, MarketParams marketParams);
    event SetFee(Id indexed id, uint256 newFee);
    event SetFeeRecipient(address indexed newFeeRecipient);
    event EnableIrm(address indexed irm);
    event EnableLltv(uint256 lltv);
    event Supply(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event Withdraw(
        Id indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );
    event Borrow(
        Id indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );
    event Repay(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event SupplyCollateral(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets);
    event WithdrawCollateral(
        Id indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets
    );
    event Liquidate(
        Id indexed id,
        address indexed caller,
        address indexed borrower,
        uint256 repaidAssets,
        uint256 repaidShares,
        uint256 seizedAssets,
        uint256 badDebtAssets,
        uint256 badDebtShares
    );
    event FlashLoan(address indexed caller, address indexed token, uint256 assets);
    event SetAuthorization(
        address indexed caller,
        address indexed authorizer,
        address indexed authorized,
        bool newIsAuthorized
    );
    event IncrementNonce(address indexed caller, address indexed authorizer, uint256 usedNonce);
    event AccrueInterest(Id indexed id, uint256 prevBorrowRate, uint256 interest, uint256 feeShares);

    error MarketNotCreated();
    error MarketAlreadyCreated();
    error IrmNotEnabled();
    error LltvNotEnabled();
    error AlreadySet();
    error MaxLltvExceeded();
    error MaxFeeExceeded();
    error InconsistentInput();
    error ZeroAddress();
    error ZeroAssets();
    error Unauthorized();
    error InsufficientCollateral();
    error InsufficientLiquidity();
    error HealthyPosition();
    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();

    function feeRecipient() external view returns (address);
    function isIrmEnabled(address irm) external view returns (bool);
    function isLltvEnabled(uint256 lltv) external view returns (bool);
    function isAuthorized(address authorizer, address authorized) external view returns (bool);
    function nonce(address authorizer) external view returns (uint256);

    function position(Id id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function market(Id id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );
    function idToMarketParams(Id id)
        external
        view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);

    function enableIrm(address irm) external;
    function enableLltv(uint256 lltv) external;
    function setFee(MarketParams memory marketParams, uint256 newFee) external;
    function setFeeRecipient(address newFeeRecipient) external;

    function createMarket(MarketParams memory marketParams) external;

    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied);

    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);

    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;

    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;

    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes memory data
    ) external returns (uint256 seized, uint256 repaid);

    function flashLoan(address token, uint256 assets, bytes calldata data) external;

    function setAuthorization(address authorized, bool newIsAuthorized) external;
    function setAuthorizationWithSig(Authorization calldata authorization, Signature calldata signature) external;

    function accrueInterest(MarketParams memory marketParams) external;
}
