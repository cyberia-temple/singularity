// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title A tank of CYBER that pays a newcomer's first fees
/// @notice An address that holds USDC on Cyberia but no CYBER cannot move its USDC: fees are paid
/// in the coin the chain runs on. The station sends such an address a small drip of CYBER, and the
/// user then signs their own transaction as usual -- no forwarder, no smart account, nothing in the
/// wallet's signing paths changes, so every action is covered, including ones not yet written.
///
/// Who deserves a drip is a question about the world (does the address hold anything, has it asked
/// ten times today) and the backend answers it with an operator key. What the station will do *at
/// most*, whoever asks and whoever has stolen that key, is answered here: a fixed drip, only to an
/// address below a balance ceiling, once per cooldown, under a daily cap. The protocol's fee router
/// keeps the tank filled.
contract GasStation is AccessManaged, ReentrancyGuardTransient {
    uint256 public dripAmount;
    uint256 public balanceCeiling;
    uint256 public cooldown;
    uint256 public dailyCap;

    mapping(address => uint256) public lastClaimAt;
    mapping(address => uint256) public claimCount;
    mapping(uint256 day => uint256) public spentOnDay;

    uint256 public totalSponsored;
    uint256 public sponsoredCount;

    event Funded(address indexed from, uint256 amount);
    event Sponsored(address indexed to, uint256 amount, address indexed operator);
    event PolicySet(uint256 dripAmount, uint256 balanceCeiling, uint256 cooldown, uint256 dailyCap);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error NotEligible(string reason);
    error BadPolicy();
    error TransferFailed();

    constructor(address authority) AccessManaged(authority) {
        // At Cyberia's fee floor 0.01 CYBER covers hundreds of transfers or a dozen swaps; the ceiling
        // is one swap's worth -- the point below which an address is stuck.
        dripAmount = 0.01 ether;
        balanceCeiling = 0.001 ether;
        cooldown = 6 hours;
        dailyCap = 5 ether;
        emit PolicySet(dripAmount, balanceCeiling, cooldown, dailyCap);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Send one drip to `to`
    function claim(address payable to) external restricted nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, string memory reason) = canClaim(to);
        if (!ok) revert NotEligible(reason);

        amount = dripAmount;
        lastClaimAt[to] = block.timestamp;
        claimCount[to] += 1;
        spentOnDay[block.timestamp / 1 days] += amount;
        totalSponsored += amount;
        sponsoredCount += 1;

        (bool sent,) = to.call{value: amount}("");
        if (!sent) revert TransferFailed();

        emit Sponsored(to, amount, msg.sender);
    }

    /// @notice Whether `to` may be sponsored now, and why not when it may not -- the same checks
    /// `claim` enforces, so the backend and the wallet never keep a second copy of the policy
    function canClaim(address to) public view returns (bool ok, string memory reason) {
        if (address(this).balance < dripAmount) return (false, "station empty");
        if (to.balance >= balanceCeiling) return (false, "has gas");
        if (lastClaimAt[to] != 0 && block.timestamp < lastClaimAt[to] + cooldown) return (false, "cooling down");
        if (spentOnDay[block.timestamp / 1 days] + dripAmount > dailyCap) return (false, "daily cap reached");
        return (true, "");
    }

    function remainingToday() external view returns (uint256) {
        uint256 spent = spentOnDay[block.timestamp / 1 days];
        return spent >= dailyCap ? 0 : dailyCap - spent;
    }

    function setPolicy(uint256 dripAmount_, uint256 balanceCeiling_, uint256 cooldown_, uint256 dailyCap_)
        external
        restricted
    {
        if (dripAmount_ == 0 || dailyCap_ < dripAmount_) revert BadPolicy();
        dripAmount = dripAmount_;
        balanceCeiling = balanceCeiling_;
        cooldown = cooldown_;
        dailyCap = dailyCap_;
        emit PolicySet(dripAmount_, balanceCeiling_, cooldown_, dailyCap_);
    }

    function withdraw(address payable to, uint256 amount) external restricted nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        (bool sent,) = to.call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit Withdrawn(to, amount);
    }
}
