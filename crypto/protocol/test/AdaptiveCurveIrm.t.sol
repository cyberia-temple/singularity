// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {AdaptiveCurveIrm} from "../contracts/lending/irm/AdaptiveCurveIrm.sol";
import {MarketParams, Market, Id} from "../contracts/lending/interfaces/ILending.sol";
import {MarketParamsLib} from "../contracts/lending/MarketParamsLib.sol";

contract AdaptiveCurveIrmTest is Test {
    using MarketParamsLib for MarketParams;

    AdaptiveCurveIrm irm;
    MarketParams params;

    uint256 constant YEAR = 365 days;

    function setUp() public {
        irm = new AdaptiveCurveIrm(address(this));
        params = MarketParams(address(1), address(2), address(3), address(irm), 0.8e18);
    }

    function _market(uint256 supplied, uint256 borrowed, uint256 lastUpdate) internal pure returns (Market memory m) {
        m.totalSupplyAssets = uint128(supplied);
        m.totalBorrowAssets = uint128(borrowed);
        m.lastUpdate = uint128(lastUpdate);
    }

    function _apr(uint256 perSecond) internal pure returns (uint256) {
        return perSecond * YEAR;
    }

    function test_onlyLendingMovesState() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(AdaptiveCurveIrm.NotLending.selector);
        irm.borrowRate(params, _market(1, 1, 0));
    }

    function test_startsAtFourPercentAtTarget() public {
        uint256 rate = irm.borrowRate(params, _market(100, 90, block.timestamp));
        assertApproxEqRel(_apr(rate), 0.04e18, 0.0001e18);
    }

    function test_curveAroundTarget() public {
        irm.borrowRate(params, _market(100, 90, block.timestamp));

        uint256 idle = irm.borrowRateView(params, _market(100, 0, block.timestamp));
        uint256 full = irm.borrowRateView(params, _market(100, 100, block.timestamp));

        assertApproxEqRel(_apr(idle), 0.01e18, 0.001e18, "a quarter of target when nothing is borrowed");
        assertApproxEqRel(_apr(full), 0.16e18, 0.001e18, "four times target when everything is");
    }

    function test_targetDoublesInAboutFiveDaysAtFullUtilization() public {
        irm.borrowRate(params, _market(100, 90, block.timestamp));
        uint256 start = uint256(irm.rateAtTarget(params.id()));

        uint256 t0 = block.timestamp;
        skip(5.06 days);
        irm.borrowRate(params, _market(100, 100, t0));
        uint256 end = uint256(irm.rateAtTarget(params.id()));

        assertApproxEqRel(end, start * 2, 0.02e18);
    }

    function test_targetFallsWhenIdleAndStaysBounded() public {
        irm.borrowRate(params, _market(100, 90, block.timestamp));

        uint256 t0 = block.timestamp;
        skip(10 * YEAR);
        irm.borrowRate(params, _market(100, 0, t0));
        assertEq(irm.rateAtTarget(params.id()), irm.MIN_RATE_AT_TARGET());

        t0 = block.timestamp;
        skip(100 * YEAR);
        irm.borrowRate(params, _market(100, 100, t0));
        assertEq(irm.rateAtTarget(params.id()), irm.MAX_RATE_AT_TARGET(), "a century of full use is capped, not overflowed");
    }
}
