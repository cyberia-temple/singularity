// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Epoch} from "../libraries/Epoch.sol";
import {Ash} from "../tokens/Ash.sol";
import {Voter} from "./Voter.sol";

/// @title ASH's emission schedule
/// @notice Once a week, anyone may call `updatePeriod`: it mints that week's ASH -- a fixed share to
/// the treasury, the rest to the `Voter` for the gauges -- and lowers next week's amount by
/// `decayBps`. The schedule is a falling geometric series that stops at ASH's cap, so the total that
/// will ever be emitted is known on the day the first week is minted.
///
/// @dev A week in which nobody called `updatePeriod` is not caught up later: it is simply not
/// emitted, and the schedule does not decay for it either.
contract Minter is AccessManaged {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    /// @notice The treasury's share never exceeds a tenth of a week
    uint256 public constant MAX_TREASURY_BPS = 1_000;

    Ash public immutable ash;
    Voter public immutable voter;

    /// @notice What next week's emission is multiplied by, in basis points (9900 = 1% less a week)
    uint256 public immutable decayBps;

    /// @notice The next week's emission
    uint256 public weekly;
    uint256 public treasuryBps;
    address public treasury;

    /// @notice The last epoch minted; zero until the schedule starts
    uint256 public lastEpoch;

    event Started(uint256 epoch, uint256 weekly);
    event Minted(uint256 indexed epoch, uint256 toVoter, uint256 toTreasury, uint256 nextWeekly);
    event TreasurySet(address indexed treasury, uint256 bps);

    error AlreadyStarted();
    error BadSettings();

    constructor(address authority, Ash ash_, Voter voter_, uint256 decayBps_, address treasury_, uint256 treasuryBps_)
        AccessManaged(authority)
    {
        if (decayBps_ > BPS || treasuryBps_ > MAX_TREASURY_BPS || treasury_ == address(0)) revert BadSettings();
        ash = ash_;
        voter = voter_;
        decayBps = decayBps_;
        treasury = treasury_;
        treasuryBps = treasuryBps_;
    }

    /// @notice Start the schedule with this week's emission
    function start(uint256 initialWeekly) external restricted {
        if (lastEpoch != 0) revert AlreadyStarted();
        weekly = initialWeekly;
        lastEpoch = Epoch.current() - 1;
        emit Started(Epoch.current(), initialWeekly);
    }

    /// @notice Mint this week's emission, if it has not been minted yet
    function updatePeriod() external returns (uint256 minted) {
        uint256 epoch = Epoch.current();
        if (lastEpoch == 0 || epoch <= lastEpoch) return 0;
        lastEpoch = epoch;

        uint256 room = ash.cap() - ash.totalSupply();
        minted = weekly < room ? weekly : room;
        weekly = weekly * decayBps / BPS;
        if (minted == 0) return 0;

        uint256 toTreasury = minted * treasuryBps / BPS;
        uint256 toVoter = minted - toTreasury;

        if (toTreasury > 0) ash.mint(treasury, toTreasury);
        if (toVoter > 0) {
            ash.mint(address(this), toVoter);
            IERC20(address(ash)).forceApprove(address(voter), toVoter);
            voter.notifyRewardAmount(toVoter);
        }

        emit Minted(epoch, toVoter, toTreasury, weekly);
    }

    function setTreasury(address treasury_, uint256 treasuryBps_) external restricted {
        if (treasury_ == address(0) || treasuryBps_ > MAX_TREASURY_BPS) revert BadSettings();
        treasury = treasury_;
        treasuryBps = treasuryBps_;
        emit TreasurySet(treasury_, treasuryBps_);
    }
}
