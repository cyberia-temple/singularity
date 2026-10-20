// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IOracle} from "../lending/interfaces/IOracle.sol";
import {IV3Pool} from "../interfaces/IV3.sol";
import {V3TwapOracle} from "./V3TwapOracle.sol";

/// @title One address per price
/// @notice Oracles are deployed here by CREATE2 from what they read, so the oracle for "token X in
/// WCYBER from pool P over 30 minutes" has one address, anyone can deploy it, and anyone can check
/// that an address claiming to be it is it. Lending markets name their oracle by address, so this
/// is also what makes two people opening "the same" market actually open the same market.
contract OracleFactory {
    /// @notice Every oracle this factory deployed
    mapping(address => bool) public isOracle;

    event TwapOracleCreated(
        address indexed oracle, address indexed pool, address indexed baseToken, uint32 window, uint32 minWindow
    );
    event ChainedOracleCreated(address indexed oracle, address indexed first, address indexed second);

    /// @notice The TWAP oracle for these parameters, deploying it if it does not exist yet
    function twap(address pool, address baseToken, uint32 window, uint32 minWindow) external returns (address oracle) {
        bytes32 salt = keccak256(abi.encode(pool, baseToken, window, minWindow));
        oracle = _predict(salt, _twapCode(pool, baseToken, window, minWindow));
        if (oracle.code.length > 0) return oracle;

        oracle = address(new V3TwapOracle{salt: salt}(IV3Pool(pool), baseToken, window, minWindow));
        isOracle[oracle] = true;
        emit TwapOracleCreated(oracle, pool, baseToken, window, minWindow);
    }

    /// @notice The oracle that prices A in C through B: `first` prices A in B, `second` B in C
    function chained(address first, address second) external returns (address oracle) {
        bytes32 salt = keccak256(abi.encode(first, second));
        oracle = _predict(salt, _chainedCode(first, second));
        if (oracle.code.length > 0) return oracle;

        oracle = address(new ChainedOracle{salt: salt}(IOracle(first), IOracle(second)));
        isOracle[oracle] = true;
        emit ChainedOracleCreated(oracle, first, second);
    }

    function predictTwap(address pool, address baseToken, uint32 window, uint32 minWindow)
        external
        view
        returns (address)
    {
        return _predict(keccak256(abi.encode(pool, baseToken, window, minWindow)), _twapCode(pool, baseToken, window, minWindow));
    }

    function _twapCode(address pool, address baseToken, uint32 window, uint32 minWindow)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(V3TwapOracle).creationCode, abi.encode(pool, baseToken, window, minWindow));
    }

    function _chainedCode(address first, address second) private pure returns (bytes memory) {
        return abi.encodePacked(type(ChainedOracle).creationCode, abi.encode(first, second));
    }

    function _predict(bytes32 salt, bytes memory code) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(code))))));
    }
}

/// @notice A in C as (A in B) × (B in C)
contract ChainedOracle is IOracle {
    IOracle public immutable first;
    IOracle public immutable second;

    constructor(IOracle first_, IOracle second_) {
        first = first_;
        second = second_;
    }

    function price() external view returns (uint256) {
        return Math.mulDiv(first.price(), second.price(), 1e36);
    }
}
