/**
 * Vendor the third-party contracts Cyberia's genesis places at their usual addresses.
 *
 *   node scripts/predeploys.ts [--rpc https://api.avax-test.network/ext/bc/C/rpc] [--teleporter <creation bytecode file>]
 *
 * They cannot be deployed the usual way on Cyberia: Safe's singleton factory and Teleporter both
 * use presigned transactions with a fixed gas price (Nick's method), and Cyberia's minimum base fee
 * is far above it -- on purpose, so that no transaction signed for the old chain 49406 is valid on
 * the new one (see genesis.ts). Genesis gets their runtime code instead, from a chain where they
 * were deployed canonically (the Fuji C-Chain), checked before it is written:
 *
 *   - **Safe 1.4.1** (the multisig every admin role sits behind): each contract's code hash must
 *     equal the one Safe publishes in safe-deployments. The singleton's constructor leaves
 *     `threshold = 1` in slot 4 so it can never be set up directly; genesis keeps that.
 *   - **TeleporterMessenger v1.0.0** (ICM, which ICTT is built on): the runtime is cut from the
 *     creation bytecode Ava Labs publishes with the release and must equal the code on the C-Chain.
 *     Its constructor sets slots 0 and 1 (the reentrancy guards) to 1, and its one-shot deployer
 *     address gets nonce 1 so the presigned deployment can never run.
 *
 * Writes scripts/lib/predeploys.json, which genesis.ts reads offline and checks again.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicClient, getAddress, http, keccak256, type Address, type Hex } from "viem";

import { ROOT } from "./lib/create2.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export type Predeploy = {
  name: string;
  address: Address;
  code: Hex;
  codeHash: Hex;
  storage?: Record<Hex, Hex>;
  nonce?: number;
  source: string;
};

/** Safe 1.4.1, canonical deployments (safe-global/safe-deployments, src/assets/v1.4.1). */
const SAFE_1_4_1: { name: string; address: Address; codeHash: Hex; storage?: Record<Hex, Hex> }[] = [
  {
    name: "SafeL2",
    address: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    codeHash: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
    storage: { [slot(4)]: slot(1) },
  },
  {
    name: "SafeProxyFactory",
    address: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    codeHash: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  },
  {
    name: "CompatibilityFallbackHandler",
    address: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
    codeHash: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
  },
  {
    name: "MultiSendCallOnly",
    address: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
    codeHash: "0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939",
  },
  {
    name: "MultiSend",
    address: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
    codeHash: "0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77",
  },
  {
    name: "SignMessageLib",
    address: "0xd53cd0aB83D845Ac265BE939c57F53AD838012c9",
    codeHash: "0x525c754a46b79e05543a59bb61e8de3c9eee0d955a59352409cbe67ea1077528",
  },
  {
    name: "CreateCall",
    address: "0x9b35Af71d77eaf8d7e40252370304687390A1A52",
    codeHash: "0x2b3060c55fcb8275653e99ad511a71f67ba76934ed66a7d74d6e68b52afff889",
  },
];

/** TeleporterMessenger v1.0.0 (ava-labs/icm-contracts release v1.0.0): same address on every chain. */
export const TELEPORTER_MESSENGER: Address = "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf";
export const TELEPORTER_DEPLOYER: Address = "0x618FEdD9A45a8C456812ecAAE70C671c6249DfaC";
const TELEPORTER_RELEASE =
  "https://github.com/ava-labs/icm-contracts/releases/download/v1.0.0/TeleporterMessenger_Bytecode_v1.0.0.txt";

function slot(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/**
 * Teleporter's creation code is a short constructor (two SSTOREs) followed by CODECOPY of the
 * runtime: `61 <len:2> 80 61 <offset:2> 6000 39 6000 f3`. Read the offset and length from it.
 */
function runtimeFromCreation(creation: Hex): Hex {
  const hex = creation.replace(/^0x/, "").trim();
  const copy = hex.match(/61([0-9a-f]{4})8061([0-9a-f]{4})6000396000f3/);
  if (!copy) throw new Error("TeleporterMessenger creation code: no CODECOPY of the runtime found");
  const length = parseInt(copy[1], 16);
  const offset = parseInt(copy[2], 16);
  const runtime = hex.slice(offset * 2, (offset + length) * 2);
  if (runtime.length !== length * 2) throw new Error("TeleporterMessenger creation code is shorter than its runtime");
  return `0x${runtime}`;
}

async function main(): Promise<void> {
  const rpc = arg("rpc", "https://api.avax-test.network/ext/bc/C/rpc");
  const client = createPublicClient({ transport: http(rpc) });
  const predeploys: Predeploy[] = [];

  for (const safe of SAFE_1_4_1) {
    const code = await client.getCode({ address: safe.address });
    if (!code || code === "0x") throw new Error(`${safe.name}: no code at ${safe.address} on ${rpc}`);
    if (keccak256(code) !== safe.codeHash) throw new Error(`${safe.name}: code hash differs from safe-deployments`);
    for (const [key, value] of Object.entries(safe.storage ?? {})) {
      const onChain = await client.getStorageAt({ address: safe.address, slot: key as Hex });
      if (onChain !== value) throw new Error(`${safe.name}: slot ${key} is ${onChain} on ${rpc}, expected ${value}`);
    }
    predeploys.push({ ...safe, code, source: `Safe 1.4.1 canonical, code from ${rpc}` });
  }

  const teleporterFile = arg("teleporter", "");
  const creation = (
    teleporterFile ? fs.readFileSync(teleporterFile, "utf8") : await (await fetch(TELEPORTER_RELEASE)).text()
  ).trim() as Hex;
  const runtime = runtimeFromCreation(creation.startsWith("0x") ? creation : (`0x${creation}` as Hex));
  const deployed = await client.getCode({ address: TELEPORTER_MESSENGER });
  if (deployed?.toLowerCase() !== runtime.toLowerCase()) {
    throw new Error(`TeleporterMessenger: the release's runtime differs from the code at ${TELEPORTER_MESSENGER} on ${rpc}`);
  }
  predeploys.push({
    name: "TeleporterMessenger",
    address: TELEPORTER_MESSENGER,
    code: runtime,
    codeHash: keccak256(runtime),
    storage: { [slot(0)]: slot(1), [slot(1)]: slot(1) },
    nonce: 1,
    source: "icm-contracts v1.0.0 release bytecode, equal to the Fuji C-Chain deployment",
  });
  predeploys.push({
    name: "TeleporterMessengerDeployer",
    address: getAddress(TELEPORTER_DEPLOYER),
    code: "0x",
    codeHash: keccak256("0x"),
    nonce: 1,
    source: "the presigned deployment's sender; nonce 1 so it can never run",
  });

  const out = path.join(ROOT, "scripts/lib/predeploys.json");
  fs.writeFileSync(out, JSON.stringify(predeploys, null, 2) + "\n");
  for (const p of predeploys) console.log(`${p.name.padEnd(30)} ${p.address} ${(p.code.length - 2) / 2} bytes`);
  console.log(`wrote ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
