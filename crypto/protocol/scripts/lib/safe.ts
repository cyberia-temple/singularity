/**
 * The project's Safe, computed before it exists.
 *
 * validator-manager.ts creates it on the C-Chain through the canonical SafeProxyFactory with a salt
 * taken from the subnet ID. Genesis predeploys the same factory and singleton on the L1, so the same
 * call there yields the same address: the mainnet genesis credits the DAO's coins to that address,
 * and the Safe is deployed on the L1 later with the very owners, threshold and salt the C-Chain one
 * used. Owners can change after that (swapOwner, addOwner); the address stays.
 */

import { concat, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";

export const SAFE_L2: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
export const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
export const SAFE_FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

/** SafeProxyFactory 1.4.1's proxyCreationCode(), as the factory at SAFE_PROXY_FACTORY on the C-Chain returns it. */
export const SAFE_PROXY_CREATION_CODE: Hex =
  "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";

export const SAFE_ABI = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export function safeInitializer(owners: Address[], threshold: bigint): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [owners, threshold, ZERO, "0x", SAFE_FALLBACK_HANDLER, ZERO, 0n, ZERO],
  });
}

/** The salt validator-manager.ts gives the Safe of the subnet with this (hex) ID. */
export function safeSalt(subnetID: Hex): bigint {
  return BigInt(keccak256(toHex(`cyberia validator manager ${subnetID}`)));
}

/** Where createProxyWithNonce(SAFE_L2, safeInitializer(owners, threshold), salt) puts the Safe. */
export function predictSafe(owners: Address[], threshold: bigint, salt: bigint): Address {
  const factorySalt = keccak256(concat([keccak256(safeInitializer(owners, threshold)), encodeAbiParameters([{ type: "uint256" }], [salt])]));
  const bytecode = concat([SAFE_PROXY_CREATION_CODE, encodeAbiParameters([{ type: "address" }], [SAFE_L2])]);
  return getContractAddress({ opcode: "CREATE2", from: SAFE_PROXY_FACTORY, salt: factorySalt, bytecode });
}
