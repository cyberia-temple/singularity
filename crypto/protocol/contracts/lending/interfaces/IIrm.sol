// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {MarketParams, Market} from "./ILending.sol";

/// @notice An interest rate model. Rates are per second, in WAD.
interface IIrm {
    /// @notice The rate to charge since `market.lastUpdate`; may update the model's own state
    /// @dev Called by the lending book alone, once per accrual
    function borrowRate(MarketParams memory marketParams, Market memory market) external returns (uint256);

    /// @notice The same rate, without touching state
    function borrowRateView(MarketParams memory marketParams, Market memory market) external view returns (uint256);
}
