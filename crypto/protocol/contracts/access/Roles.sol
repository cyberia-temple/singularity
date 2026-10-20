// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// @title Who may do what, across the whole protocol
/// @notice Every restricted function of every contract answers to one `AccessManager`. A function
/// not listed here is ADMIN-only. The deploy script maps the functions below to these roles; this
/// library is the single written record of that mapping.
///
///  - ADMIN (0, built into AccessManager) -- the governance multisig, with an execution delay: every
///    admin action is scheduled and can be watched before it runs.
///  - GUARDIAN -- may only stop things: pause the bridge, block a name zone, retire a gauge.
///  - OPERATOR -- the backend's key: gas drips, onboarding names, badges, the resolver's markets.
///  - RELAYER -- the bridge relayer: release, finalize, refund, inside each asset's rate limit.
///  - LAUNCHPAD -- may create gauges; held by the Launchpad contract (and governance).
///  - ARBITER -- settles disputed prediction markets.
library Roles {
    uint64 internal constant ADMIN = 0;
    uint64 internal constant GUARDIAN = 1;
    uint64 internal constant OPERATOR = 2;
    uint64 internal constant RELAYER = 3;
    uint64 internal constant LAUNCHPAD = 4;
    uint64 internal constant ARBITER = 5;
}
