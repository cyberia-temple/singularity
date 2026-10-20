// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

/// @title One collection anyone can mint into
/// @notice The tokenURI is given at mint: an `ipfs://` CID of standard metadata, a link, or a line of
/// text -- an NFT does not need an image. The minter may name a royalty of up to 10% on every resale
/// (ERC-2981), which the Cyberia NFT market pays.
contract CyberiaNFT is ERC721URIStorage, ERC2981 {
    uint96 public constant MAX_ROYALTY_BPS = 1_000;

    uint256 public nextId;

    event Minted(uint256 indexed tokenId, address indexed creator, string uri, uint96 royaltyBps);

    error EmptyURI();
    error RoyaltyTooHigh();

    constructor() ERC721("Cyberia NFT", "CNFT") {}

    function mint(string calldata uri, uint96 royaltyBps) external returns (uint256 tokenId) {
        if (bytes(uri).length == 0) revert EmptyURI();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();

        tokenId = ++nextId;
        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
        if (royaltyBps > 0) _setTokenRoyalty(tokenId, msg.sender, royaltyBps);

        emit Minted(tokenId, msg.sender, uri, royaltyBps);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
