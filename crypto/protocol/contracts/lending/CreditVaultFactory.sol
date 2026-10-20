// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ILending} from "./interfaces/ILending.sol";
import {CreditVault} from "./CreditVault.sol";

/// @title Anyone can run a lending vault
/// @notice A curator who knows which markets are worth lending into can open a vault, set a fee on
/// the interest it earns, and let depositors follow their judgement. The protocol's own vaults are
/// opened the same way, with its operator as curator.
contract CreditVaultFactory {
    ILending public immutable lending;
    address public immutable implementation;

    mapping(address vault => bool) public isVault;
    address[] public allVaults;

    event VaultCreated(address indexed vault, address indexed asset, address indexed curator, string name);

    constructor(ILending lending_) {
        lending = lending_;
        implementation = address(new CreditVault(lending_));
    }

    function createVault(IERC20 asset, string calldata name, string calldata symbol, address curator)
        external
        returns (address vault)
    {
        vault = Clones.clone(implementation);
        CreditVault(vault).initialize(asset, name, symbol, curator);
        isVault[vault] = true;
        allVaults.push(vault);
        emit VaultCreated(vault, address(asset), curator, name);
    }

    function allVaultsLength() external view returns (uint256) {
        return allVaults.length;
    }
}
