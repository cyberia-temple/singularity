// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// @notice Hooks the lending book calls on `msg.sender` when an action carries `data`, after the
/// book's own state is final and before it pulls the tokens it is owed. They are what lets one
/// transaction open a leveraged position, refinance, or liquidate without capital.
interface ILendingSupplyCallback {
    function onLendingSupply(uint256 assets, bytes calldata data) external;
}

interface ILendingRepayCallback {
    function onLendingRepay(uint256 assets, bytes calldata data) external;
}

interface ILendingSupplyCollateralCallback {
    function onLendingSupplyCollateral(uint256 assets, bytes calldata data) external;
}

interface ILendingLiquidateCallback {
    function onLendingLiquidate(uint256 repaidAssets, bytes calldata data) external;
}

interface ILendingFlashLoanCallback {
    function onLendingFlashLoan(uint256 assets, bytes calldata data) external;
}
