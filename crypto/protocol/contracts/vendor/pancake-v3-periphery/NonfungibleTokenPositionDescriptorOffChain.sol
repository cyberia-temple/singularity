// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '@openzeppelin/contracts-v3/utils/Strings.sol';

import './interfaces/INonfungibleTokenPositionDescriptor.sol';

/// @title Describes NFT token positions by pointing at an off-chain renderer
/// @dev Cyberia: upstream is an `Initializable` proxy implementation. Nothing here is upgraded, so the
/// base URI is a constructor argument and the upgradeable dependency is gone.
contract NonfungibleTokenPositionDescriptorOffChain is INonfungibleTokenPositionDescriptor {
    using Strings for uint256;

    string private _baseTokenURI;

    constructor(string memory baseTokenURI) {
        _baseTokenURI = baseTokenURI;
    }

    /// @inheritdoc INonfungibleTokenPositionDescriptor
    function tokenURI(INonfungiblePositionManager, uint256 tokenId) external view override returns (string memory) {
        return bytes(_baseTokenURI).length > 0 ? string(abi.encodePacked(_baseTokenURI, tokenId.toString())) : '';
    }
}
