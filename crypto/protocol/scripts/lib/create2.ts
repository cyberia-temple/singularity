/**
 * The two contracts whose addresses genesis must know before they exist.
 *
 * The bridge gateway holds, from block 0, the CYBER that backs every CYBER.sol not yet brought over
 * from Solana. Genesis can only credit an address it can compute, so the gateway -- and the
 * authority it is constructed with -- are deployed through the deterministic CREATE2 deployer that
 * genesis also places at its usual address. Both scripts compute the addresses here, from the same
 * artifacts, so the backing and the contract always meet.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { concat, encodeAbiParameters, getContractAddress, keccak256, toHex, type Address, type Hex } from "viem";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Arachnid's deterministic deployment proxy, present on most EVM chains and in Cyberia's genesis. */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const CREATE2_DEPLOYER_CODE: Hex =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

export const SALT_AUTHORITY: Hex = keccak256(toHex("cyberia.authority.v1"));
export const SALT_GATEWAY: Hex = keccak256(toHex("cyberia.bridge-gateway.v1"));

function creationCode(name: string, file: string): Hex {
  const artifactPath = path.join(ROOT, "artifacts", file, `${name}.json`);
  if (!fs.existsSync(artifactPath)) throw new Error(`missing ${artifactPath}; run npx hardhat build`);
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")).bytecode;
}

export function authorityInitCode(deployer: Address): Hex {
  return concat([
    creationCode("CyberiaAuthority", "contracts/access/CyberiaAuthority.sol"),
    encodeAbiParameters([{ type: "address" }], [deployer]),
  ]);
}

export function gatewayInitCode(authority: Address): Hex {
  return concat([
    creationCode("BridgeGateway", "contracts/bridge/BridgeGateway.sol"),
    encodeAbiParameters([{ type: "address" }], [authority]),
  ]);
}

export function predict(salt: Hex, initCode: Hex): Address {
  return getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initCode });
}

/** The authority and gateway a given deployer key will create. */
export function predictCore(deployer: Address): { authority: Address; gateway: Address } {
  const authority = predict(SALT_AUTHORITY, authorityInitCode(deployer));
  const gateway = predict(SALT_GATEWAY, gatewayInitCode(authority));
  return { authority, gateway };
}
