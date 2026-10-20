// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";

/// @title The one authority every Cyberia contract answers to
/// @notice OpenZeppelin's AccessManager, deployed once. Roles and the functions they unlock are
/// listed in `Roles`; the deploy script applies that mapping. Admin actions carry an execution delay
/// for the governance multisig, so this contract is also the protocol's timelock.
contract CyberiaAuthority is AccessManager {
    constructor(address initialAdmin) AccessManager(initialAdmin) {}
}
