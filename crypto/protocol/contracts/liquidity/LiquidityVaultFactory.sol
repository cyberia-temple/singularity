// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IV3Factory, IV3Pool} from "../interfaces/IV3.sol";
import {LiquidityVault} from "./LiquidityVault.sol";

/// @title One full-range vault per pool, for anyone to open
/// @notice Vaults are clones at an address derived from their pool, so there is exactly one per
/// pool, it can be predicted before it exists, and opening it is permissionless -- for a launch
/// pool, for a stable pair, for anything the DEX lists.
contract LiquidityVaultFactory {
    IV3Factory public immutable dexFactory;
    address public immutable implementation;

    mapping(address pool => address vault) public vaultOf;
    address[] public allVaults;

    event VaultCreated(address indexed pool, address indexed vault);

    error NotADexPool();
    error VaultExists();

    constructor(IV3Factory dexFactory_) {
        dexFactory = dexFactory_;
        implementation = address(new LiquidityVault());
    }

    function create(address pool) external returns (address vault) {
        if (vaultOf[pool] != address(0)) revert VaultExists();

        IV3Pool p = IV3Pool(pool);
        address token0 = p.token0();
        address token1 = p.token1();
        if (dexFactory.getPool(token0, token1, p.fee()) != pool) {
            // The pool's fee may have been retuned away from the tier its address was derived from,
            // so look it up by tier too before refusing.
            if (!_isDexPool(pool, token0, token1)) revert NotADexPool();
        }

        vault = Clones.cloneDeterministic(implementation, bytes32(uint256(uint160(pool))));
        string memory pair = string.concat(_symbol(token0), "-", _symbol(token1));
        LiquidityVault(vault).initialize(p, string.concat("Cyberia LP ", pair), string.concat("CLP-", pair));

        vaultOf[pool] = vault;
        allVaults.push(vault);
        emit VaultCreated(pool, vault);
    }

    function predict(address pool) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, bytes32(uint256(uint160(pool))));
    }

    function allVaultsLength() external view returns (uint256) {
        return allVaults.length;
    }

    /// @dev A pool's fee is mutable on this fork while its address is derived from the tier it was
    /// created in, so membership is checked against every tier a pool can be created in.
    function _isDexPool(address pool, address token0, address token1) internal view returns (bool) {
        uint24[5] memory tiers = [uint24(100), 500, 2500, 10000, 110000];
        for (uint256 i = 0; i < tiers.length; i++) {
            if (dexFactory.getPool(token0, token1, tiers[i]) == pool) return true;
        }
        return false;
    }

    function _symbol(address token) internal view returns (string memory) {
        try IERC20Metadata(token).symbol() returns (string memory s) {
            return s;
        } catch {
            return "?";
        }
    }
}
