/**
 * Cyberia's validator set, kept on the C-Chain: Ava Labs' ValidatorManager behind a proxy, a PoAManager
 * that owns it, and a Safe that owns both.
 *
 *   node scripts/validator-manager.ts vendor
 *   node scripts/validator-manager.ts deploy --subnet-id <cb58> --owners 0x…,0x…,0x… --threshold 2 \
 *       [--churn-period 86400] [--max-churn 20]
 *   platform-cli subnet convert-to-l1 --subnet-id <cb58> --chain-id <C-Chain ID> --manager <ValidatorManager> …
 *   node scripts/validator-manager.ts init --subnet-id <cb58> --conversion-tx <P-Chain tx ID> \
 *       [--aggregator http://127.0.0.1:8080] [--p-chain https://api.avax-test.network/ext/bc/P]
 *
 * Environment: RPC_URL (the C-Chain) and DEPLOYER_PK, as for deploy.ts. Addresses and completed steps
 * go to deployments/<chainId>.json and a rerun picks up where the last one stopped.
 *
 * Why the C-Chain: a manager on the L1 itself stops with the L1. If the L1's validators go away (their
 * P-Chain balance runs out, a provider drops them), nobody could register new ones; on the C-Chain the
 * Safe still can.
 *
 *   - **ValidatorManager** (icm-services at ICM_SERVICES_COMMIT): the implementation refuses
 *     initialization; the TransparentUpgradeableProxy in front of it is initialized instead, and the
 *     ProxyAdmin it creates belongs to the Safe. The P-Chain records the proxy's address at conversion
 *     and never lets it change, so the proxy is what keeps the manager fixable.
 *   - **PoAManager** owns the ValidatorManager. Only its owner, the Safe, starts adding, removing or
 *     reweighing a validator; anyone may complete one with the P-Chain's signed receipt.
 *   - **Safe 1.4.1** (SafeL2, canonical factory) with the given owners and threshold.
 *
 * `init` hands the ValidatorManager the P-Chain's record of the conversion: the
 * SubnetToL1ConversionMessage, signed by Primary Network validators (the C-Chain trusts nobody else for
 * P-Chain messages), fetched from a signature-aggregator and attached to the transaction as a Warp
 * predicate. Anyone could submit it; we do it right after converting.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  numberToHex,
  parseAbi,
  size,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = path.join(ROOT, "scripts/lib/validator-manager.json");

/**
 * ava-labs/icm-services main after validator-manager-v2.1.0: it adds the BLS key length check in
 * initializeValidatorSet and makes migrateFromV1 owner-only. Its Go bindings carry the bytecode Ava
 * Labs compiled; solc 0.8.30 (optimizer 200, shanghai) reproduces their executable code byte for byte
 * from the sources at this commit; only the metadata hash at the end differs, since it records
 * build paths.
 */
export const ICM_SERVICES_COMMIT = "bb0aca41c3fc16aa8c0db7765da56217291654b0";
const BINDINGS = `https://raw.githubusercontent.com/ava-labs/icm-services/${ICM_SERVICES_COMMIT}/abi-bindings/go/validator-manager`;
const BINDING_FILES: Record<string, string> = {
  ValidatorMessages: "ValidatorManager/ValidatorManager.go",
  ValidatorManager: "ValidatorManager/ValidatorManager.go",
  PoAManager: "PoAManager/PoAManager.go",
};
/** solc's placeholder for the ValidatorMessages library inside ValidatorManager's bytecode. */
const VALIDATOR_MESSAGES_PLACEHOLDER = "__$add2235b6a6cf493060b757d4655105486$__";

const SAFE_L2: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const WARP_PRECOMPILE: Address = "0x0200000000000000000000000000000000000005";
const ERC1967_ADMIN_SLOT: Hex = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const PRIMARY_NETWORK_ID = "11111111111111111111111111111111LpoYY";
/** Avalanche network IDs by C-Chain chain ID: Warp messages are signed for a network. */
const NETWORK_IDS: Record<number, number> = { 43114: 1, 43113: 5 };
const C_CHAIN_IDS: Record<number, string> = {
  43114: "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5",
  43113: "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp",
};

const SAFE_ABI = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);
const OWNABLE_ABI = parseAbi(["function owner() view returns (address)"]);

type Vendored = { name: string; abi: Abi; bytecode: Hex; codeHash: Hex; source: string };

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

// ------------------------------------------------------------------------------------ cb58

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Avalanche's cb58: base58 of the bytes and the last four bytes of their SHA-256. */
export function cb58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error(`cb58: '${char}' is not base58`);
    value = value * 58n + BigInt(digit);
  }
  const hex = value.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = text.length - text.replace(/^1+/, "").length;
  const bytes = Buffer.concat([Buffer.alloc(zeros), body]);
  const payload = bytes.subarray(0, -4);
  const checksum = createHash("sha256").update(payload).digest().subarray(-4);
  if (!checksum.equals(bytes.subarray(-4))) throw new Error(`cb58: bad checksum in ${text}`);
  return new Uint8Array(payload);
}

const id32 = (cb58: string): Hex => {
  const bytes = cb58Decode(cb58);
  if (bytes.length !== 32) throw new Error(`${cb58} is not a 32-byte ID`);
  return toHex(bytes);
};
/** A node ID as the P-Chain's JSON gives it: hex in a ConvertSubnetToL1Tx, `NodeID-<cb58>` elsewhere. */
const nodeIdBytes = (nodeId: string): Hex =>
  nodeId.startsWith("0x") ? (nodeId.toLowerCase() as Hex) : toHex(cb58Decode(nodeId.replace(/^NodeID-/, "")));

// ---------------------------------------------------------------------------------- vendor

/** Pull ABI and creation bytecode out of an abigen file's `<Name>MetaData`. */
function fromBinding(source: string, name: string): { abi: Abi; bytecode: Hex } {
  const block = source.match(new RegExp(`var ${name}MetaData = &bind\\.MetaData\\{([\\s\\S]*?)\\n\\}`));
  if (!block) throw new Error(`no ${name}MetaData in the bindings`);
  const abi = block[1].match(/ABI:\s*"((?:[^"\\]|\\.)*)"/);
  const bin = block[1].match(/Bin:\s*"(0x[0-9a-fA-F_$]+)"/);
  if (!abi || !bin) throw new Error(`${name}MetaData has no ABI or Bin`);
  return { abi: JSON.parse(JSON.parse(`"${abi[1]}"`)), bytecode: bin[1] as Hex };
}

async function vendor(): Promise<void> {
  const out: Vendored[] = [];
  for (const [name, file] of Object.entries(BINDING_FILES)) {
    const response = await fetch(`${BINDINGS}/${file}`);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const { abi, bytecode } = fromBinding(await response.text(), name);
    out.push({ name, abi, bytecode, codeHash: keccak256(bytecode as Hex), source: `icm-services@${ICM_SERVICES_COMMIT} ${file}` });
  }
  const manager = out.find((v) => v.name === "ValidatorManager")!;
  if (!manager.bytecode.includes(VALIDATOR_MESSAGES_PLACEHOLDER)) {
    throw new Error("ValidatorManager no longer links ValidatorMessages under the expected placeholder");
  }
  fs.writeFileSync(VENDORED, JSON.stringify(out, null, 2) + "\n");
  for (const v of out) console.log(`${v.name.padEnd(18)} ${(v.bytecode.length - 2) / 2} bytes ${v.codeHash}`);
  console.log(`wrote ${VENDORED}`);
}

function vendored(name: string): Vendored {
  const all: Vendored[] = JSON.parse(fs.readFileSync(VENDORED, "utf8"));
  const v = all.find((entry) => entry.name === name);
  if (!v) throw new Error(`${name} is not in ${VENDORED}; run vendor`);
  if (keccak256(v.bytecode) !== v.codeHash) throw new Error(`${name}'s bytecode does not match its hash`);
  return v;
}

function proxyArtifact(): { abi: Abi; bytecode: Hex } {
  const file = path.join(
    ROOT,
    "artifacts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json",
  );
  if (!fs.existsSync(file)) throw new Error(`missing ${file}; run npx hardhat build`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------------- chain

async function connect() {
  const RPC_URL = process.env.RPC_URL;
  const PK = process.env.DEPLOYER_PK;
  if (!RPC_URL || !PK) throw new Error("RPC_URL and DEPLOYER_PK must be set");
  const account = privateKeyToAccount((PK.startsWith("0x") ? PK : `0x${PK}`) as Hex);
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const chain = {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  } as const;
  const wallet = createWalletClient({ account, chain, transport });

  const recordPath = path.join(ROOT, "deployments", `${chainId}.json`);
  type DeployRecord = { chainId: number; deployer: Address; contracts: Record<string, Address>; steps: string[] };
  const record: DeployRecord = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, "utf8"))
    : { chainId, deployer: account.address, contracts: {}, steps: [] };
  const save = () => {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  };

  async function sent(hash: Hex, what: string) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${what} failed: ${hash}`);
    return receipt;
  }

  async function deploy(key: string, abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
    if (record.contracts[key]) {
      console.log(`  = ${key} ${record.contracts[key]}`);
      return getAddress(record.contracts[key]);
    }
    const receipt = await sent(await wallet.deployContract({ abi, bytecode, args }), `deploy ${key}`);
    record.contracts[key] = getAddress(receipt.contractAddress!);
    save();
    console.log(`  + ${key} ${record.contracts[key]}`);
    return record.contracts[key];
  }

  return { account, chainId, publicClient, wallet, record, save, sent, deploy };
}

// ---------------------------------------------------------------------------------- deploy

async function deployAll(): Promise<void> {
  const subnetID = id32(arg("subnet-id"));
  const owners = arg("owners").split(",").map((a) => getAddress(a.trim()));
  const threshold = BigInt(arg("threshold"));
  const churnPeriodSeconds = BigInt(arg("churn-period", "86400"));
  const maximumChurnPercentage = Number(arg("max-churn", "20"));
  if (threshold < 1n || threshold > BigInt(owners.length)) throw new Error("--threshold must be between 1 and the owner count");

  const { account, publicClient, wallet, record, save, sent, deploy } = await connect();
  const managerVendored = vendored("ValidatorManager");
  const messages = vendored("ValidatorMessages");
  const poa = vendored("PoAManager");

  if (!record.contracts.Safe) {
    const initializer = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "setup",
      args: [owners, threshold, `0x${"0".repeat(40)}`, "0x", SAFE_FALLBACK_HANDLER, `0x${"0".repeat(40)}`, 0n, `0x${"0".repeat(40)}`],
    });
    const salt = BigInt(keccak256(toHex(`cyberia validator manager ${subnetID}`)));
    const hash = await wallet.writeContract({
      address: SAFE_PROXY_FACTORY,
      abi: SAFE_ABI,
      functionName: "createProxyWithNonce",
      args: [SAFE_L2, initializer, salt],
    });
    const receipt = await sent(hash, "create Safe");
    const created = receipt.logs
      .filter((log) => getAddress(log.address) === SAFE_PROXY_FACTORY)
      .map((log) => decodeEventLog({ abi: SAFE_ABI, data: log.data, topics: log.topics }))
      .find((event) => event.eventName === "ProxyCreation");
    if (!created) throw new Error("the factory created no Safe");
    record.contracts.Safe = getAddress((created.args as { proxy: Address }).proxy);
    save();
    console.log(`  + Safe ${record.contracts.Safe}`);
  } else {
    console.log(`  = Safe ${record.contracts.Safe}`);
  }
  const safe = record.contracts.Safe;

  const library = await deploy("ValidatorMessages", messages.abi, messages.bytecode);
  const linked = managerVendored.bytecode.split(VALIDATOR_MESSAGES_PLACEHOLDER).join(library.slice(2).toLowerCase()) as Hex;
  const implementation = await deploy("ValidatorManagerImplementation", managerVendored.abi, linked, [1]); // ICMInitializable.Disallowed

  const initialize = encodeFunctionData({
    abi: managerVendored.abi,
    functionName: "initialize",
    args: [{ admin: account.address, subnetID, churnPeriodSeconds, maximumChurnPercentage }],
  });
  const proxy = proxyArtifact();
  const manager = await deploy("ValidatorManager", proxy.abi, proxy.bytecode, [implementation, safe, initialize]);
  const poaManager = await deploy("PoAManager", poa.abi, poa.bytecode, [safe, manager]);

  const handOver = "ValidatorManager.transferOwnership(PoAManager)";
  if (!record.steps.includes(handOver)) {
    await sent(
      await wallet.writeContract({ address: manager, abi: managerVendored.abi, functionName: "transferOwnership", args: [poaManager] }),
      handOver,
    );
    record.steps.push(handOver);
    save();
    console.log(`  + ${handOver}`);
  }

  const adminSlot = await publicClient.getStorageAt({ address: manager, slot: ERC1967_ADMIN_SLOT });
  const proxyAdmin = getAddress(`0x${adminSlot!.slice(-40)}`);
  if (record.contracts.ProxyAdmin !== proxyAdmin) {
    record.contracts.ProxyAdmin = proxyAdmin;
    save();
  }

  const read = (address: Address, abi: Abi, functionName: string) => publicClient.readContract({ address, abi, functionName });
  const checks: [string, unknown, unknown][] = [
    ["ValidatorManager owner is PoAManager", await read(manager, OWNABLE_ABI, "owner"), poaManager],
    ["PoAManager owner is the Safe", await read(poaManager, OWNABLE_ABI, "owner"), safe],
    ["ProxyAdmin owner is the Safe", await read(proxyAdmin, OWNABLE_ABI, "owner"), safe],
    ["subnet", await read(manager, managerVendored.abi, "subnetID"), subnetID],
    ["churn period", await read(manager, managerVendored.abi, "getChurnPeriodSeconds"), churnPeriodSeconds],
    ["Safe threshold", await read(safe, SAFE_ABI, "getThreshold"), threshold],
    ["Safe owners", ((await read(safe, SAFE_ABI, "getOwners")) as Address[]).join(","), owners.join(",")],
  ];
  for (const [what, actual, expected] of checks) {
    if (actual !== expected) throw new Error(`${what}: ${actual} != ${expected}`);
    console.log(`  ✓ ${what}`);
  }
  console.log(`\nconvert with --manager ${manager}`);
}

// ------------------------------------------------------------------------------------ init

type ConversionData = {
  subnetID: Hex;
  validatorManagerBlockchainID: Hex;
  validatorManagerAddress: Address;
  initialValidators: { nodeID: Hex; blsPublicKey: Hex; weight: bigint }[];
};

const u16 = (n: number): Hex => numberToHex(n, { size: 2 });
const u32 = (n: number): Hex => numberToHex(n, { size: 4 });
const u64 = (n: bigint): Hex => numberToHex(n, { size: 8 });
const withLength = (bytes: Hex): Hex => concat([u32(size(bytes)), bytes]);

/** ValidatorMessages.packConversionData: the bytes whose SHA-256 is the conversion ID. */
export function packConversionData(data: ConversionData): Hex {
  return concat([
    u16(0),
    data.subnetID,
    data.validatorManagerBlockchainID,
    withLength(data.validatorManagerAddress.toLowerCase() as Hex),
    u32(data.initialValidators.length),
    ...data.initialValidators.flatMap((v) => [withLength(v.nodeID), v.blsPublicKey, u64(v.weight)]),
  ]);
}

/** An unsigned Warp message from the P-Chain carrying a SubnetToL1ConversionMessage. */
export function conversionWarpMessage(networkID: number, conversionID: Hex): Hex {
  const payload = concat([u16(0), u32(0), conversionID]); // SubnetToL1ConversionMessage
  const addressedCall = concat([u16(0), u32(1), withLength("0x"), withLength(payload)]);
  return concat([u16(0), u32(networkID), `0x${"0".repeat(64)}`, withLength(addressedCall)]);
}

/** Subnet-EVM's predicate encoding: the bytes, a 0xff delimiter, zero padding to 32-byte words. */
export function predicateKeys(signed: Hex): Hex[] {
  const bytes = Buffer.concat([Buffer.from(signed.slice(2), "hex"), Buffer.from([0xff])]);
  const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]);
  const keys: Hex[] = [];
  for (let i = 0; i < padded.length; i += 32) keys.push(`0x${padded.subarray(i, i + 32).toString("hex")}`);
  return keys;
}

async function pChain(url: string, method: string, params: object): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: any; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function init(): Promise<void> {
  const subnetCb58 = arg("subnet-id");
  const subnetID = id32(subnetCb58);
  const conversionTx = arg("conversion-tx");
  const aggregator = arg("aggregator", "http://127.0.0.1:8080");
  const pChainUrl = arg("p-chain", "https://api.avax-test.network/ext/bc/P");

  const { chainId, publicClient, wallet, record, save, sent } = await connect();
  const managerVendored = vendored("ValidatorManager");
  const manager = record.contracts.ValidatorManager;
  if (!manager) throw new Error("no ValidatorManager in the deployment record; run deploy");
  const step = "ValidatorManager.initializeValidatorSet";
  if (record.steps.includes(step)) {
    console.log(`  = ${step}`);
    return;
  }

  const { tx } = await pChain(pChainUrl, "platform.getTx", { txID: conversionTx, encoding: "json" });
  const unsigned = tx.unsignedTx;
  if (unsigned.subnetID !== subnetCb58) throw new Error(`${conversionTx} converts ${unsigned.subnetID}, not ${subnetCb58}`);
  if (unsigned.chainID !== C_CHAIN_IDS[chainId]) throw new Error(`${conversionTx} puts the manager on ${unsigned.chainID}, not this C-Chain`);
  if (getAddress(unsigned.address) !== manager) throw new Error(`${conversionTx} names manager ${unsigned.address}, not ${manager}`);

  const data: ConversionData = {
    subnetID,
    validatorManagerBlockchainID: id32(unsigned.chainID),
    validatorManagerAddress: manager,
    initialValidators: unsigned.validators.map((v: any) => ({
      nodeID: nodeIdBytes(v.nodeID),
      blsPublicKey: v.signer.publicKey as Hex,
      weight: BigInt(v.weight),
    })),
  };
  const conversionID = toHex(createHash("sha256").update(Buffer.from(packConversionData(data).slice(2), "hex")).digest());
  const subnet = await pChain(pChainUrl, "platform.getSubnet", { subnetID: subnetCb58 });
  if (id32(subnet.conversionID) !== conversionID) {
    throw new Error(`conversion ID ${conversionID} differs from the P-Chain's ${subnet.conversionID}`);
  }
  console.log(`  ✓ conversion ID ${subnet.conversionID} matches the P-Chain`);

  const response = await fetch(`${aggregator}/aggregate-signatures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: conversionWarpMessage(NETWORK_IDS[chainId], conversionID).slice(2),
      justification: subnetID.slice(2),
      "signing-subnet-id": PRIMARY_NETWORK_ID,
      "quorum-percentage": 67,
      "quorum-percentage-buffer": 3,
    }),
  });
  const body = (await response.json()) as { "signed-message"?: string; error?: string };
  if (!response.ok) throw new Error(`aggregator: HTTP ${response.status} ${body.error ?? ""}`);
  const signed = `0x${String(body["signed-message"]).replace(/^0x/, "")}` as Hex;
  console.log(`  ✓ signed by Primary Network validators (${size(signed)} bytes)`);

  const hash = await wallet.writeContract({
    address: manager,
    abi: managerVendored.abi,
    functionName: "initializeValidatorSet",
    args: [data, 0],
    accessList: [{ address: WARP_PRECOMPILE, storageKeys: predicateKeys(signed) }],
    gas: 3_000_000n,
  });
  await sent(hash, step);
  record.steps.push(step);
  save();
  const weight = await publicClient.readContract({ address: manager, abi: managerVendored.abi, functionName: "l1TotalWeight" });
  console.log(`  + ${step}: ${data.initialValidators.length} validator(s), total weight ${weight} (${hash})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const command = process.argv[2];
  if (command === "vendor") await vendor();
  else if (command === "deploy") await deployAll();
  else if (command === "init") await init();
  else throw new Error("usage: validator-manager.ts vendor | deploy … | init …");
}
