// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Configurable Cyberia asset representation
/// @notice An operator-issued accounting token, not a claim on an underlying
///         security or a promise of redemption unless separately arranged.
/// @dev Mirrors the owner mint/burn interface of the existing Cyberia wrappers.
contract ManagedAsset is ERC20, ERC20Burnable, ERC20Permit, Ownable {
    uint8 private immutable _assetDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address initialOwner
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        require(bytes(name_).length != 0, "ManagedAsset: empty name");
        require(bytes(symbol_).length != 0, "ManagedAsset: empty symbol");
        require(initialOwner != address(0), "ManagedAsset: zero owner");
        require(decimals_ <= 18, "ManagedAsset: decimals > 18");

        _assetDecimals = decimals_;
        _transferOwnership(initialOwner);
    }

    function decimals() public view override returns (uint8) {
        return _assetDecimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Owner may burn a holder's balance without allowance, matching
    ///         the existing bridged-asset convention. This is custodial power.
    function burnFrom(address from, uint256 amount) public override {
        if (msg.sender == owner()) {
            _burn(from, amount);
            return;
        }
        super.burnFrom(from, amount);
    }
}
