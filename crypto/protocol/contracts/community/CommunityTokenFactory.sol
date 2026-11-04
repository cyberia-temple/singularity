// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {CommunityToken} from "./CommunityToken.sol";

/// @title Community tokens for anyone
/// @notice Successor of the Telegram token factory and the generic voting-token factory: one call
/// makes a mintable, voting token owned by whoever is named. Anyone may call it; a token says who
/// can mint it, and nothing else about the factory is privileged.
contract CommunityTokenFactory {
    address public immutable implementation;

    address[] public allTokens;
    mapping(address token => bool) public isToken;

    event TokenCreated(address indexed token, address indexed owner, string name, string symbol, uint256 maxSupply);

    constructor() {
        implementation = address(new CommunityToken());
    }

    function createToken(string calldata name, string calldata symbol, address owner, uint256 maxSupply)
        external
        returns (address token)
    {
        token = Clones.clone(implementation);
        CommunityToken(token).initialize(name, symbol, owner, maxSupply);
        allTokens.push(token);
        isToken[token] = true;
        emit TokenCreated(token, owner, name, symbol, maxSupply);
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }
}
