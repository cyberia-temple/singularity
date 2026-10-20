// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// @notice What the launchpad needs from the modules that make up a token's economy. Each one is
/// optional: a module left unset is simply not offered.

interface IGaugeRegistry {
    function createGauge(address stakingToken) external returns (address gauge);
    function gaugeOf(address stakingToken) external view returns (address gauge);
}

interface IZoneRegistry {
    function createZone(address token) external returns (string memory zone);
}

interface IDAOFactory {
    function createDAO(address token) external returns (address governor, address timelock);
}

interface ILaunchRegistry {
    function isLaunched(address token) external view returns (bool);
}
