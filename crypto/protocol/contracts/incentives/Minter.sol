// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Epoch} from "../libraries/Epoch.sol";
import {Ash} from "../tokens/Ash.sol";
import {Voter} from "./Voter.sol";

interface ILockedCyber {
    function totalCyberLocked() external view returns (uint256);
}

/// @title Ash from fire
/// @notice ASH is not emitted on a timetable. It is made from CYBER that has left circulation for
/// good -- **the fire**:
///
///  - transaction fees, which the chain burns into the blackhole address;
///  - everything burned through the `Furnace`: the protocol's share of revenue, `.cyber` names,
///    anyone feeding it;
///  - CYBER locked forever in launch pools, which can never come back out.
///
/// Once a week `updatePeriod` measures the week's fire and mints `rate` ASH for every CYBER of it,
/// plus a decaying **kindling** that carries the first months while the fire is small. No week may
/// mint more than `ceilingBps` of what is left under ASH's cap. A chain nobody uses therefore makes
/// almost no ASH, a busy one makes a lot, and all of ASH can only exist once all of CYBER is gone.
///
/// Each week's ASH is split: `buildersBps` to the builders' fund (open-source contributors),
/// `treasuryBps` to the treasury, and the rest to the `Voter`, which sends it to the farms lockers
/// voted for.
///
/// @dev Heat is read from two counters anyone can check -- the blackhole's balance and the
/// launchpad's locked total -- as the difference since the last mint. A week nobody mints is not
/// lost: its heat is counted at the next mint (its kindling is).
contract Minter is AccessManaged {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    /// @notice Where subnet-evm burns fees, and where the Furnace sends what it burns
    address public constant BLACKHOLE = 0x0100000000000000000000000000000000000000;

    uint256 public constant MAX_BUILDERS_BPS = 2_500;
    uint256 public constant MAX_TREASURY_BPS = 1_500;

    Ash public immutable ash;
    Voter public immutable voter;
    ILockedCyber public immutable launchpad;

    /// @notice ASH minted per CYBER burned (both 18 decimals, so this is a plain ratio)
    uint256 public immutable rate;

    /// @notice The most one week may mint, as a share of what is left under the cap
    uint256 public immutable ceilingBps;

    /// @notice What next week's kindling is multiplied by
    uint256 public immutable kindlingDecayBps;

    /// @notice Next week's kindling
    uint256 public kindling;

    uint256 public buildersBps;
    uint256 public treasuryBps;
    address public builders;
    address public treasury;

    /// @notice The last epoch minted; zero until the schedule starts
    uint256 public lastEpoch;
    uint256 public lastBurned;
    uint256 public lastLocked;

    /// @notice CYBER of fire counted so far, and ASH made from it
    uint256 public totalHeat;
    uint256 public totalFromFire;

    event Started(uint256 epoch, uint256 kindling);
    event Minted(
        uint256 indexed epoch,
        uint256 heat,
        uint256 fromFire,
        uint256 fromKindling,
        uint256 toVoter,
        uint256 toBuilders,
        uint256 toTreasury
    );
    event SplitSet(address builders, uint256 buildersBps, address treasury, uint256 treasuryBps);

    error AlreadyStarted();
    error BadSettings();

    constructor(
        address authority,
        Ash ash_,
        Voter voter_,
        ILockedCyber launchpad_,
        uint256 rate_,
        uint256 ceilingBps_,
        uint256 kindlingDecayBps_
    ) AccessManaged(authority) {
        if (ceilingBps_ == 0 || ceilingBps_ > BPS || kindlingDecayBps_ > BPS) revert BadSettings();
        ash = ash_;
        voter = voter_;
        launchpad = launchpad_;
        rate = rate_;
        ceilingBps = ceilingBps_;
        kindlingDecayBps = kindlingDecayBps_;
    }

    // ---------------------------------------------------------------------------------- views

    /// @notice CYBER that has burned or been locked since the last mint
    function heat() public view returns (uint256 burned, uint256 locked) {
        burned = BLACKHOLE.balance - lastBurned;
        locked = launchpad.totalCyberLocked() - lastLocked;
    }

    /// @notice What `updatePeriod` would mint right now, before the split
    function preview() public view returns (uint256 fromFire, uint256 fromKindling, uint256 total) {
        if (lastEpoch == 0 || Epoch.current() <= lastEpoch) return (0, 0, 0);
        (uint256 burned, uint256 locked) = heat();
        fromFire = (burned + locked) * rate;
        fromKindling = kindling;

        uint256 ceiling = (ash.cap() - ash.totalSupply()) * ceilingBps / BPS;
        total = fromFire + fromKindling;
        if (total > ceiling) {
            // The ceiling trims kindling first: fire is the reason ASH exists.
            total = ceiling;
            if (fromFire > ceiling) fromFire = ceiling;
            fromKindling = total - fromFire;
        }
    }

    // --------------------------------------------------------------------------------- minting

    /// @notice Start the schedule, with the first week's kindling
    function start(uint256 initialKindling) external restricted {
        if (lastEpoch != 0) revert AlreadyStarted();
        if (builders == address(0) || treasury == address(0)) revert BadSettings();
        kindling = initialKindling;
        lastEpoch = Epoch.current() - 1;
        lastBurned = BLACKHOLE.balance;
        lastLocked = launchpad.totalCyberLocked();
        emit Started(Epoch.current(), initialKindling);
    }

    /// @notice Turn the fire since the last mint into ASH, once a week
    function updatePeriod() external returns (uint256 minted) {
        uint256 epoch = Epoch.current();
        if (lastEpoch == 0 || epoch <= lastEpoch) return 0;

        (uint256 burned, uint256 locked) = heat();
        (uint256 fromFire, uint256 fromKindling, uint256 total) = preview();

        lastEpoch = epoch;
        lastBurned += burned;
        lastLocked += locked;
        kindling = kindling * kindlingDecayBps / BPS;
        totalHeat += burned + locked;
        totalFromFire += fromFire;

        minted = total;
        if (minted == 0) return 0;

        uint256 toBuilders = minted * buildersBps / BPS;
        uint256 toTreasury = minted * treasuryBps / BPS;
        uint256 toVoter = minted - toBuilders - toTreasury;

        if (toBuilders > 0) ash.mint(builders, toBuilders);
        if (toTreasury > 0) ash.mint(treasury, toTreasury);
        if (toVoter > 0) {
            ash.mint(address(this), toVoter);
            IERC20(address(ash)).forceApprove(address(voter), toVoter);
            voter.notifyRewardAmount(toVoter);
        }

        emit Minted(epoch, burned + locked, fromFire, fromKindling, toVoter, toBuilders, toTreasury);
    }

    function setSplit(address builders_, uint256 buildersBps_, address treasury_, uint256 treasuryBps_)
        external
        restricted
    {
        if (builders_ == address(0) || treasury_ == address(0)) revert BadSettings();
        if (buildersBps_ > MAX_BUILDERS_BPS || treasuryBps_ > MAX_TREASURY_BPS) revert BadSettings();
        builders = builders_;
        buildersBps = buildersBps_;
        treasury = treasury_;
        treasuryBps = treasuryBps_;
        emit SplitSet(builders_, buildersBps_, treasury_, treasuryBps_);
    }
}
