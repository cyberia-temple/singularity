// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Id, ILending, MarketParams, Market} from "./interfaces/ILending.sol";
import {IIrm} from "./interfaces/IIrm.sol";
import {MarketParamsLib} from "./MarketParamsLib.sol";
import {MathLib} from "../libraries/MathLib.sol";
import {SharesMath} from "../libraries/SharesMath.sol";

/// @title What the lending book will say after its next accrual, without causing one
/// @notice The book's stored totals are only as fresh as the last action in a market. These views
/// run the same accrual arithmetic forward to now, so a vault can value its positions and a screen
/// can show a balance that is right to the second.
library LendingViews {
    using MathLib for uint256;
    using SharesMath for uint256;
    using MarketParamsLib for MarketParams;

    function market(ILending lending, Id id) internal view returns (Market memory m) {
        (m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee) =
            lending.market(id);
    }

    function expectedMarketBalances(ILending lending, MarketParams memory params)
        internal
        view
        returns (uint256 totalSupplyAssets, uint256 totalSupplyShares, uint256 totalBorrowAssets, uint256 totalBorrowShares)
    {
        Market memory m = market(lending, params.id());
        (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares) =
            (m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares);

        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0 || m.totalBorrowAssets == 0 || params.irm == address(0)) {
            return (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares);
        }

        uint256 rate = IIrm(params.irm).borrowRateView(params, m);
        uint256 interest = totalBorrowAssets.wMulDown(rate.wTaylorCompounded(elapsed));
        totalBorrowAssets += interest;
        totalSupplyAssets += interest;

        if (m.fee != 0) {
            uint256 feeAmount = interest.wMulDown(m.fee);
            totalSupplyShares += feeAmount.toSharesDown(totalSupplyAssets - feeAmount, totalSupplyShares);
        }
    }

    function expectedSupplyAssets(ILending lending, MarketParams memory params, address user)
        internal
        view
        returns (uint256)
    {
        (uint256 supplyShares,,) = lending.position(params.id(), user);
        (uint256 totalSupplyAssets, uint256 totalSupplyShares,,) = expectedMarketBalances(lending, params);
        return supplyShares.toAssetsDown(totalSupplyAssets, totalSupplyShares);
    }

    function expectedBorrowAssets(ILending lending, MarketParams memory params, address user)
        internal
        view
        returns (uint256)
    {
        (, uint128 borrowShares,) = lending.position(params.id(), user);
        (,, uint256 totalBorrowAssets, uint256 totalBorrowShares) = expectedMarketBalances(lending, params);
        return uint256(borrowShares).toAssetsUp(totalBorrowAssets, totalBorrowShares);
    }

    /// @notice What a market could pay out right now
    function liquidity(ILending lending, MarketParams memory params) internal view returns (uint256) {
        (uint256 totalSupplyAssets,, uint256 totalBorrowAssets,) = expectedMarketBalances(lending, params);
        return totalSupplyAssets - totalBorrowAssets;
    }
}
