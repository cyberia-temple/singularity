// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";

/// @title An asset from another chain, as it exists on this one
/// @notice One implementation for every bridged asset -- USDC, BTC, SOL, TON, a Solana memecoin --
/// cloned per asset with its own name, symbol and decimals. Supply moves only through the
/// `BridgeGateway`: it mints against a deposit verified on the asset's home chain, and burns what
/// was escrowed once the matching payout there is confirmed.
///
/// @dev The old wrappers each let their owner -- one relayer key shared with two bots -- mint any
/// amount and burn from any address without an allowance. Here the gateway can mint only within
/// its per-asset rate limit and burn only its own balance; nobody can touch a holder's tokens.
contract BridgedToken is ERC20PermitUpgradeable {
    /// @notice The only minter and burner
    address public immutable gateway;

    uint8 private _decimals;

    /// @notice Where the asset really lives: a chain id from the gateway's own list, and the asset's
    /// identifier there (an address, a mint, a ticker -- whatever that chain calls it)
    uint64 public originChain;
    bytes32 public originId;

    error NotGateway();

    modifier onlyGateway() {
        if (msg.sender != gateway) revert NotGateway();
        _;
    }

    constructor(address gateway_) {
        gateway = gateway_;
        _disableInitializers();
    }

    function initialize(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint64 originChain_,
        bytes32 originId_
    ) external initializer onlyGateway {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        _decimals = decimals_;
        originChain = originChain_;
        originId = originId_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyGateway {
        _mint(to, amount);
    }

    /// @notice Burn from the gateway's own balance -- what it holds in escrow
    function burn(uint256 amount) external onlyGateway {
        _burn(msg.sender, amount);
    }
}
