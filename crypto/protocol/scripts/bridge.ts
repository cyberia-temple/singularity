/**
 * The CYBER bridge between the C-Chain and a Cyberia L1: Ava Labs' ICTT, upgradeable.
 *
 *   node scripts/bridge.ts vendor
 *   RPC_URL=<C-Chain> DEPLOYER_PK=<ops>  node scripts/bridge.ts home --safe 0x… (--token 0x… | --test-token)
 *   RPC_URL=<L1>      DEPLOYER_PK=<ops>  node scripts/bridge.ts registry --safe 0x…
 *   RPC_URL=<L1> PEER_RPC_URL=<C-Chain> DEPLOYER_PK=<ictt> node scripts/bridge.ts remote --safe 0x…
 *   RPC_URL=<L1> PEER_RPC_URL=<C-Chain> DEPLOYER_PK=<any>  node scripts/bridge.ts register
 *   RPC_URL=<C-Chain> PEER_RPC_URL=<L1> DEPLOYER_PK=<ops>  node scripts/bridge.ts collateral
 *   RPC_URL=<either>  PEER_RPC_URL=<the other> DEPLOYER_PK=<sender> node scripts/bridge.ts send --amount 10 [--recipient 0x…]
 *
 * Addresses and completed steps go to deployments/<chainId>.json as for validator-manager.ts, and a
 * rerun picks up where the last one stopped.
 *
 *   - **C-Chain:** ERC20TokenHome holds CYBER.sol (Wormhole Portal's wrap, 6 decimals) and releases
 *     exactly what comes back burned from the L1.
 *   - **L1:** NativeTokenRemote mints native CYBER for what the home locked. It is the only address
 *     genesis lets mint: the proxy at CREATE(the remote deployer, nonce 1), its implementation being
 *     nonce 0. A failed or misordered transaction from that key burns the nonce, and the minter's
 *     address with it, for good — so `remote` refuses unless the key is at the expected nonce, the
 *     predicted proxy is the NativeMinter's enabled address, and both deployments succeed in a
 *     simulation first. Genesis' own coins (gas for the operator and this deployer) are the remote's
 *     initialReserveImbalance: the home lets nothing cross until that much CYBER.sol is locked.
 *   - Both sides sit behind a TransparentUpgradeableProxy whose ProxyAdmin belongs to a
 *     TimelockController (48 h) with the DAO Safe as its only proposer and executor. The Safe is also
 *     each side's teleporterManager: it can pause a Teleporter version or raise the minimum one, and
 *     nothing else — no mint, no withdrawal.
 *
 * Contracts come from Ava Labs' Go bindings at ICM_SERVICES_COMMIT, like the validator manager's.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toEventSelector,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  ERC1967_ADMIN_SLOT,
  ICM_SERVICES_COMMIT,
  OWNABLE_ABI,
  arg,
  connect,
  fromBinding,
  proxyArtifact,
} from "./validator-manager.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = path.join(ROOT, "scripts/lib/ictt.json");
const BINDINGS = `https://raw.githubusercontent.com/ava-labs/icm-services/${ICM_SERVICES_COMMIT}/abi-bindings/go`;
const BINDING_FILES: Record<string, string> = {
  ERC20TokenHomeUpgradeable: "ictt/TokenHome/ERC20TokenHomeUpgradeable/ERC20TokenHomeUpgradeable.go",
  NativeTokenRemoteUpgradeable: "ictt/TokenRemote/NativeTokenRemoteUpgradeable/NativeTokenRemoteUpgradeable.go",
  TeleporterRegistry: "teleporter/registry/TeleporterRegistry/TeleporterRegistry.go",
};

/** Teleporter v1.0.0: the same address on every chain (genesis predeploys it on ours). */
export const TELEPORTER_MESSENGER: Address = "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf";
/** Ava Labs' TeleporterRegistry on each C-Chain. */
const C_CHAIN_REGISTRY: Record<number, Address> = {
  43114: "0x7C43605E14F391720e1b37E49C78C4b03A488d98",
  43113: "0xF86Cb19Ad8405AEFa7d09C778215D2Cb6eBfB228",
};
/** Each L1 and the C-Chain its home lives on. */
export const HOME_CHAIN: Record<number, number> = { 49406: 43114, 49407: 43113 };
const REMOTE_CHAIN: Record<number, number> = Object.fromEntries(Object.entries(HOME_CHAIN).map(([l1, c]) => [c, Number(l1)]));
/** The genesis each L1 was created from: its balances are the remote's initialReserveImbalance. */
const GENESIS: Record<number, string> = {
  49406: "../../services/avalanche-node/mainnet/genesis.json",
  49407: "../../services/avalanche-node/fuji/genesis.json",
};
const NATIVE_MINTER: Address = "0x0200000000000000000000000000000000000001";
const TIMELOCK_DELAY = 48n * 3600n;
/** ICMInitializable.Disallowed: an implementation that refuses initialize(); only its proxy is initialized. */
const DISALLOWED = 1;
/** What a transfer may spend on the destination chain: a native mint on the L1, a release on the home. */
const TRANSFER_GAS = 250_000n;
const MIN_TELEPORTER_VERSION = 1n;

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);
const REGISTRY_ABI = parseAbi([
  "function latestVersion() view returns (uint256)",
  "function getAddressFromVersion(uint256) view returns (address)",
]);
const ALLOW_LIST_ABI = parseAbi(["function readAllowList(address) view returns (uint256)"]);
const TELEPORTER_ABI = parseAbi(["function messageReceived(bytes32) view returns (bool)"]);
/** Teleporter v1's SendCrossChainMessage: topics[1] is the message ID. */
const SEND_CROSS_CHAIN_MESSAGE = toEventSelector(
  "SendCrossChainMessage(bytes32,bytes32,(uint256,address,bytes32,address,uint256,address[],(uint256,address)[],bytes),(address,uint256))",
);
const TIMELOCK_ROLES_ABI = parseAbi([
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function getMinDelay() view returns (uint256)",
]);

type Vendored = { name: string; abi: Abi; bytecode: Hex; codeHash: Hex; source: string };
type Record_ = { chainId: number; deployer: Address; contracts: Record<string, Address>; steps: string[] };

// ---------------------------------------------------------------------------------- vendor

async function vendor(): Promise<void> {
  const out: Vendored[] = [];
  for (const [name, file] of Object.entries(BINDING_FILES)) {
    const response = await fetch(`${BINDINGS}/${file}`);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const { abi, bytecode } = fromBinding(await response.text(), name);
    if (bytecode.includes("__$")) throw new Error(`${name} links a library; this script deploys none`);
    out.push({ name, abi, bytecode, codeHash: keccak256(bytecode), source: `icm-services@${ICM_SERVICES_COMMIT} ${file}` });
  }
  fs.writeFileSync(VENDORED, JSON.stringify(out, null, 2) + "\n");
  for (const v of out) console.log(`${v.name.padEnd(30)} ${(v.bytecode.length - 2) / 2} bytes ${v.codeHash}`);
  console.log(`wrote ${VENDORED}`);
}

function vendored(name: string): Vendored {
  const all: Vendored[] = JSON.parse(fs.readFileSync(VENDORED, "utf8"));
  const v = all.find((entry) => entry.name === name);
  if (!v) throw new Error(`${name} is not in ${VENDORED}; run vendor`);
  if (keccak256(v.bytecode) !== v.codeHash) throw new Error(`${name}'s bytecode does not match its hash`);
  return v;
}

function artifact(file: string): { abi: Abi; bytecode: Hex } {
  const full = path.join(ROOT, "artifacts", file);
  if (!fs.existsSync(full)) throw new Error(`missing ${full}; run npx hardhat build`);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

// ---------------------------------------------------------------------------------- pieces

function readRecord(chainId: number): Record_ {
  const file = path.join(ROOT, "deployments", `${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployments/${chainId}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function peer(expectedChainId: number): Promise<PublicClient> {
  const url = process.env.PEER_RPC_URL;
  if (!url) throw new Error(`PEER_RPC_URL must be set (chain ${expectedChainId})`);
  const client = createPublicClient({ transport: http(url) }) as PublicClient;
  const id = await client.getChainId();
  if (id !== expectedChainId) throw new Error(`PEER_RPC_URL is chain ${id}, not ${expectedChainId}`);
  return client;
}

/** Sum of every balance in a genesis file, in wei. */
export function genesisSupply(genesis: { alloc: Record<string, { balance?: string }> }): bigint {
  return Object.values(genesis.alloc).reduce((sum, entry) => sum + BigInt(entry.balance ?? "0x0"), 0n);
}

/**
 * Everything `remote` checks before the remote deployer's first transaction. Pure, so a test can hold it
 * to the rules: the deployer at nonce 0 (or 1 with the implementation already in place), genesis
 * enabling exactly the predicted proxy, and the chain agreeing.
 */
export function remotePlan(input: {
  deployer: Address;
  nonce: number;
  implementationRecorded: boolean;
  genesisMinters: string[];
  minterOnChain: bigint;
}): { implementation: Address; proxy: Address; next: "implementation" | "proxy" } {
  const implementation = getContractAddress({ opcode: "CREATE", from: input.deployer, nonce: 0n });
  const proxy = getContractAddress({ opcode: "CREATE", from: input.deployer, nonce: 1n });
  const minters = input.genesisMinters.map((a) => getAddress(a));
  if (minters.length !== 1 || minters[0] !== proxy) {
    throw new Error(`genesis lets ${minters.join(", ") || "nobody"} mint, not ${proxy} = CREATE(${input.deployer}, 1)`);
  }
  if (input.minterOnChain === 0n) throw new Error(`the NativeMinter does not enable ${proxy} on this chain`);
  if (input.nonce === 0 && !input.implementationRecorded) return { implementation, proxy, next: "implementation" };
  if (input.nonce === 1 && input.implementationRecorded) return { implementation, proxy, next: "proxy" };
  throw new Error(
    `${input.deployer} is at nonce ${input.nonce} (implementation ${input.implementationRecorded ? "recorded" : "not recorded"}); ` +
      "only nonce 0 then 1 put the minter where genesis expects it. Stop and find out what that key sent.",
  );
}

async function timelock(ctx: Awaited<ReturnType<typeof connect>>, safe: Address): Promise<Address> {
  const t = artifact("@openzeppelin/contracts/governance/TimelockController.sol/TimelockController.json");
  const address = await ctx.deploy("BridgeTimelock", t.abi, t.bytecode, [TIMELOCK_DELAY, [safe], [safe], zeroAddress]);
  const read = (functionName: string, args: unknown[] = []) =>
    ctx.publicClient.readContract({ address, abi: TIMELOCK_ROLES_ABI, functionName, args } as never) as Promise<unknown>;
  if ((await read("getMinDelay")) !== TIMELOCK_DELAY) throw new Error("the timelock's delay is not 48 h");
  if (!(await read("hasRole", [await read("PROPOSER_ROLE"), safe]))) throw new Error("the Safe cannot propose");
  if (!(await read("hasRole", [await read("EXECUTOR_ROLE"), safe]))) throw new Error("the Safe cannot execute");
  return address;
}

async function proxyAdminOf(client: PublicClient, proxy: Address): Promise<Address> {
  const slot = await client.getStorageAt({ address: proxy, slot: ERC1967_ADMIN_SLOT });
  return getAddress(`0x${slot!.slice(-40)}`);
}

async function checkOwnership(
  ctx: Awaited<ReturnType<typeof connect>>,
  proxy: Address,
  abi: Abi,
  timelockAddress: Address,
  safe: Address,
  key: string,
): Promise<void> {
  const admin = await proxyAdminOf(ctx.publicClient, proxy);
  if (ctx.record.contracts[key] !== admin) {
    ctx.record.contracts[key] = admin;
    ctx.save();
  }
  const adminOwner = await ctx.publicClient.readContract({ address: admin, abi: OWNABLE_ABI, functionName: "owner" });
  if (adminOwner !== timelockAddress) throw new Error(`${key} belongs to ${adminOwner}, not the timelock`);
  const manager = await ctx.publicClient.readContract({ address: proxy, abi, functionName: "owner" });
  if (manager !== safe) throw new Error(`teleporterManager is ${manager}, not the Safe`);
  console.log(`  ✓ ${key} → timelock ${timelockAddress} (48 h, Safe ${safe}); teleporterManager = Safe`);
}

// ---------------------------------------------------------------------------------- home

async function home(): Promise<void> {
  const safe = getAddress(arg("safe"));
  const ctx = await connect();
  const registry = C_CHAIN_REGISTRY[ctx.chainId];
  if (!registry) throw new Error(`chain ${ctx.chainId} is not a C-Chain this bridge knows`);

  let token: Address;
  if (process.argv.includes("--test-token")) {
    if (ctx.chainId !== 43113) throw new Error("--test-token is for Fuji only; mainnet locks the real CYBER.sol");
    const mock = artifact("test/mocks/MockERC20.sol/MockERC20.json");
    token = await ctx.deploy("TestCyberSol", mock.abi, mock.bytecode, ["CYBER.sol (Fuji test)", "CYBER.sol", 6]);
  } else {
    token = getAddress(arg("token"));
  }
  const decimals = await ctx.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" });

  const timelockAddress = await timelock(ctx, safe);
  const homeV = vendored("ERC20TokenHomeUpgradeable");
  const implementation = await ctx.deploy("BridgeHomeImplementation", homeV.abi, homeV.bytecode, [DISALLOWED]);
  const initialize = encodeFunctionData({
    abi: homeV.abi,
    functionName: "initialize",
    args: [registry, safe, MIN_TELEPORTER_VERSION, token, decimals],
  });
  const proxy = proxyArtifact();
  const bridgeHome = await ctx.deploy("BridgeHome", proxy.abi, proxy.bytecode, [implementation, timelockAddress, initialize]);
  await checkOwnership(ctx, bridgeHome, homeV.abi, timelockAddress, safe, "BridgeHomeProxyAdmin");
  const held = await ctx.publicClient.readContract({ address: bridgeHome, abi: homeV.abi, functionName: "getTokenAddress" });
  if (held !== token) throw new Error(`the home holds ${held}, not ${token}`);
  console.log(`  ✓ home ${bridgeHome} holds ${token} (${decimals} decimals)`);
}

// ---------------------------------------------------------------------------------- L1

async function registry(): Promise<void> {
  const safe = getAddress(arg("safe"));
  const ctx = await connect();
  if (!HOME_CHAIN[ctx.chainId]) throw new Error(`chain ${ctx.chainId} is not a Cyberia L1`);
  const code = await ctx.publicClient.getCode({ address: TELEPORTER_MESSENGER });
  if (!code || code === "0x") throw new Error("no TeleporterMessenger on this chain");
  const reg = vendored("TeleporterRegistry");
  const address = await ctx.deploy("TeleporterRegistry", reg.abi, reg.bytecode, [[{ version: 1n, protocolAddress: TELEPORTER_MESSENGER }]]);
  const latest = await ctx.publicClient.readContract({ address, abi: REGISTRY_ABI, functionName: "latestVersion" });
  console.log(`  ✓ TeleporterRegistry ${address}: version ${latest} = ${TELEPORTER_MESSENGER}`);
  await timelock(ctx, safe);
}

async function remote(): Promise<void> {
  const safe = getAddress(arg("safe"));
  const ctx = await connect();
  const homeChain = HOME_CHAIN[ctx.chainId];
  if (!homeChain) throw new Error(`chain ${ctx.chainId} is not a Cyberia L1`);
  const homeClient = await peer(homeChain);
  const homeRecord = readRecord(homeChain);
  const bridgeHome = homeRecord.contracts.BridgeHome;
  if (!bridgeHome) throw new Error(`no BridgeHome in deployments/${homeChain}.json; run home`);
  const reg = ctx.record.contracts.TeleporterRegistry;
  const timelockAddress = ctx.record.contracts.BridgeTimelock;
  if (!reg || !timelockAddress) throw new Error("run registry on this chain first (with the operator's key)");
  if (ctx.record.contracts.BridgeRemote) {
    console.log(`  = BridgeRemote ${ctx.record.contracts.BridgeRemote}`);
    return;
  }

  const genesis = JSON.parse(fs.readFileSync(path.join(ROOT, GENESIS[ctx.chainId]), "utf8"));
  if (genesis.config.chainId !== ctx.chainId) throw new Error(`${GENESIS[ctx.chainId]} is chain ${genesis.config.chainId}`);
  const reserve = genesisSupply(genesis);
  const deployer = ctx.account.address;
  const nonce = await ctx.publicClient.getTransactionCount({ address: deployer });
  const predictedProxy = getContractAddress({ opcode: "CREATE", from: deployer, nonce: 1n });
  const minterOnChain = await ctx.publicClient.readContract({
    address: NATIVE_MINTER,
    abi: ALLOW_LIST_ABI,
    functionName: "readAllowList",
    args: [predictedProxy],
  });
  const plan = remotePlan({
    deployer,
    nonce,
    implementationRecorded: Boolean(ctx.record.contracts.BridgeRemoteImplementation),
    genesisMinters: genesis.config.contractNativeMinterConfig?.enabledAddresses ?? [],
    minterOnChain,
  });
  console.log(`  ✓ ${deployer} at nonce ${nonce}; genesis and the NativeMinter enable ${plan.proxy}`);

  const homeV = vendored("ERC20TokenHomeUpgradeable");
  const homeChainID = await homeClient.readContract({ address: bridgeHome, abi: homeV.abi, functionName: "getBlockchainID" });
  const homeToken = await homeClient.readContract({ address: bridgeHome, abi: homeV.abi, functionName: "getTokenAddress" });
  const homeDecimals = await homeClient.readContract({ address: homeToken as Address, abi: ERC20_ABI, functionName: "decimals" });
  console.log(`  ✓ home ${bridgeHome} on ${homeChainID}: ${homeToken}, ${homeDecimals} decimals`);
  console.log(`  ✓ initialReserveImbalance ${formatUnits(reserve, 18)} CYBER (all of genesis' balances)`);

  const remoteV = vendored("NativeTokenRemoteUpgradeable");
  const steps = [
    { key: "BridgeRemoteImplementation", nonce: 0, data: encodeDeployData({ abi: remoteV.abi, bytecode: remoteV.bytecode, args: [DISALLOWED] }) },
    {
      key: "BridgeRemote",
      nonce: 1,
      data: encodeDeployData({
        abi: proxyArtifact().abi,
        bytecode: proxyArtifact().bytecode,
        args: [
          plan.implementation,
          timelockAddress,
          encodeFunctionData({
            abi: remoteV.abi,
            functionName: "initialize",
            args: [
              {
                teleporterRegistryAddress: reg,
                teleporterManager: safe,
                minTeleporterVersion: MIN_TELEPORTER_VERSION,
                tokenHomeBlockchainID: homeChainID,
                tokenHomeAddress: bridgeHome,
                tokenHomeDecimals: homeDecimals,
              },
              "CYBER",
              reserve,
              0n,
            ],
          }),
        ],
      }),
    },
  ];
  for (const step of steps.slice(plan.next === "implementation" ? 0 : 1)) {
    const expected = getContractAddress({ opcode: "CREATE", from: deployer, nonce: BigInt(step.nonce) });
    const current = await ctx.publicClient.getTransactionCount({ address: deployer });
    if (current !== step.nonce) throw new Error(`${deployer} moved to nonce ${current} before ${step.key}; stopping`);
    // A creation eth_call runs the constructor (and the proxy's initialize) without spending the nonce.
    const simulated = await ctx.publicClient.call({ account: deployer, data: step.data });
    if (!simulated.data || simulated.data === "0x") throw new Error(`${step.key} deploys no code in simulation`);
    const gas = ((await ctx.publicClient.estimateGas({ account: deployer, data: step.data })) * 13n) / 10n;
    console.log(`  … ${step.key} at nonce ${step.nonce} → ${expected} (simulated, gas ${gas})`);
    const receipt = await ctx.sent(await ctx.wallet.sendTransaction({ data: step.data, nonce: step.nonce, gas }), step.key);
    if (getAddress(receipt.contractAddress!) !== expected) throw new Error(`${step.key} landed at ${receipt.contractAddress}`);
    ctx.record.contracts[step.key] = expected;
    ctx.save();
    console.log(`  + ${step.key} ${expected}`);
  }

  const bridgeRemote = ctx.record.contracts.BridgeRemote;
  await checkOwnership(ctx, bridgeRemote, remoteV.abi, timelockAddress, safe, "BridgeRemoteProxyAdmin");
  const read = (functionName: string) => ctx.publicClient.readContract({ address: bridgeRemote, abi: remoteV.abi, functionName });
  if ((await read("getInitialReserveImbalance")) !== reserve) throw new Error("the remote's reserve imbalance is off");
  if ((await read("getTokenHomeAddress")) !== bridgeHome) throw new Error("the remote points at another home");
  console.log(`  ✓ remote ${bridgeRemote}: ${await read("symbol")}, multiplier ${await read("getTokenMultiplier")}`);
}

// ---------------------------------------------------------------------------------- link

async function register(): Promise<void> {
  const ctx = await connect();
  const homeChain = HOME_CHAIN[ctx.chainId];
  if (!homeChain) throw new Error(`chain ${ctx.chainId} is not a Cyberia L1`);
  const homeClient = await peer(homeChain);
  const bridgeRemote = ctx.record.contracts.BridgeRemote;
  const bridgeHome = readRecord(homeChain).contracts.BridgeHome;
  if (!bridgeRemote || !bridgeHome) throw new Error("deploy home and remote first");
  const remoteV = vendored("NativeTokenRemoteUpgradeable");
  const homeV = vendored("ERC20TokenHomeUpgradeable");
  const remoteChainID = await ctx.publicClient.readContract({ address: bridgeRemote, abi: remoteV.abi, functionName: "getBlockchainID" });
  const settings = () =>
    homeClient.readContract({
      address: bridgeHome,
      abi: homeV.abi,
      functionName: "getRemoteTokenTransferrerSettings",
      args: [remoteChainID, bridgeRemote],
    }) as Promise<{ registered: boolean; collateralNeeded: bigint; tokenMultiplier: bigint; multiplyOnRemote: boolean }>;

  if (!(await settings()).registered) {
    if (!ctx.record.steps.includes("BridgeRemote.registerWithHome")) {
      await ctx.sent(
        await ctx.wallet.writeContract({
          address: bridgeRemote,
          abi: remoteV.abi,
          functionName: "registerWithHome",
          args: [{ feeTokenAddress: bridgeRemote, amount: 0n }],
        }),
        "registerWithHome",
      );
      ctx.record.steps.push("BridgeRemote.registerWithHome");
      ctx.save();
      console.log("  + registerWithHome sent; waiting for the relayer");
    }
    for (let i = 0; i < 60 && !(await settings()).registered; i++) await new Promise((r) => setTimeout(r, 5000));
  }
  const s = await settings();
  if (!s.registered) throw new Error("the home has not heard of the remote after 5 minutes; check the ICM relayer");
  console.log(`  ✓ registered on the home: multiplier ${s.tokenMultiplier} (${s.multiplyOnRemote ? "×" : "÷"} on the L1), collateral needed ${s.collateralNeeded}`);
}

async function collateral(): Promise<void> {
  const ctx = await connect();
  const remoteChain = REMOTE_CHAIN[ctx.chainId];
  if (!remoteChain) throw new Error(`chain ${ctx.chainId} is not a C-Chain this bridge knows`);
  const remoteClient = await peer(remoteChain);
  const bridgeHome = ctx.record.contracts.BridgeHome;
  const bridgeRemote = readRecord(remoteChain).contracts.BridgeRemote;
  const homeV = vendored("ERC20TokenHomeUpgradeable");
  const remoteV = vendored("NativeTokenRemoteUpgradeable");
  const remoteChainID = await remoteClient.readContract({ address: bridgeRemote, abi: remoteV.abi, functionName: "getBlockchainID" });
  const token = (await ctx.publicClient.readContract({ address: bridgeHome, abi: homeV.abi, functionName: "getTokenAddress" })) as Address;
  const { registered, collateralNeeded } = (await ctx.publicClient.readContract({
    address: bridgeHome,
    abi: homeV.abi,
    functionName: "getRemoteTokenTransferrerSettings",
    args: [remoteChainID, bridgeRemote],
  })) as { registered: boolean; collateralNeeded: bigint };
  if (!registered) throw new Error("the remote is not registered yet; run register");
  if (collateralNeeded === 0n) {
    console.log("  = the remote is collateralized");
    return;
  }
  const me = ctx.account.address;
  const balance = await ctx.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [me] });
  if (balance < collateralNeeded) {
    if (token !== ctx.record.contracts.TestCyberSol) throw new Error(`${me} holds ${balance} of ${collateralNeeded} needed`);
    await ctx.sent(await ctx.wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: "mint", args: [me, collateralNeeded] }), "mint test token");
  }
  if ((await ctx.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [me, bridgeHome] })) < collateralNeeded) {
    await ctx.sent(await ctx.wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [bridgeHome, collateralNeeded] }), "approve");
  }
  await ctx.sent(
    await ctx.wallet.writeContract({
      address: bridgeHome,
      abi: homeV.abi,
      functionName: "addCollateral",
      args: [remoteChainID, bridgeRemote, collateralNeeded],
    }),
    "addCollateral",
  );
  console.log(`  + locked ${collateralNeeded} of ${token}: genesis' coins are backed, the bridge is open`);
}

async function send(): Promise<void> {
  const ctx = await connect();
  const toL1 = Boolean(REMOTE_CHAIN[ctx.chainId]);
  const peerChain = toL1 ? REMOTE_CHAIN[ctx.chainId] : HOME_CHAIN[ctx.chainId];
  if (!peerChain) throw new Error(`chain ${ctx.chainId} has no bridge`);
  const other = await peer(peerChain);
  const homeRecord = readRecord(toL1 ? ctx.chainId : peerChain);
  const remoteRecord = readRecord(toL1 ? peerChain : ctx.chainId);
  const bridgeHome = homeRecord.contracts.BridgeHome;
  const bridgeRemote = remoteRecord.contracts.BridgeRemote;
  const homeV = vendored("ERC20TokenHomeUpgradeable");
  const remoteV = vendored("NativeTokenRemoteUpgradeable");
  const recipient = getAddress(arg("recipient", ctx.account.address));

  const here = toL1 ? bridgeHome : bridgeRemote;
  const there = toL1 ? bridgeRemote : bridgeHome;
  const destinationBlockchainID = await other.readContract({
    address: there,
    abi: toL1 ? remoteV.abi : homeV.abi,
    functionName: "getBlockchainID",
  });
  const token = (await (toL1 ? ctx.publicClient : other).readContract({ address: bridgeHome, abi: homeV.abi, functionName: "getTokenAddress" })) as Address;
  const tokenDecimals = await (toL1 ? ctx.publicClient : other).readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" });
  const amount = parseUnits(arg("amount"), toL1 ? tokenDecimals : 18);

  const input = {
    destinationBlockchainID,
    destinationTokenTransferrerAddress: there,
    recipient,
    primaryFeeTokenAddress: toL1 ? token : bridgeRemote,
    primaryFee: 0n,
    secondaryFee: 0n,
    requiredGasLimit: TRANSFER_GAS,
    multiHopFallback: zeroAddress,
  };
  let receipt: Awaited<ReturnType<typeof ctx.sent>>;
  if (toL1) {
    const me = ctx.account.address;
    if ((await ctx.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [me, bridgeHome] })) < amount) {
      await ctx.sent(await ctx.wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [bridgeHome, amount] }), "approve");
    }
    receipt = await ctx.sent(await ctx.wallet.writeContract({ address: here, abi: homeV.abi, functionName: "send", args: [input, amount] }), "send");
  } else {
    receipt = await ctx.sent(await ctx.wallet.writeContract({ address: here, abi: remoteV.abi, functionName: "send", args: [input], value: amount }), "send");
  }
  // Arrival is the destination's Teleporter receiving this very message: a recipient's balance also
  // moves for other reasons (fees, when the recipient is a fee recipient).
  const sentLog = receipt.logs.find(
    (log) => getAddress(log.address) === TELEPORTER_MESSENGER && log.topics[0] === SEND_CROSS_CHAIN_MESSAGE,
  );
  if (!sentLog) throw new Error(`${receipt.transactionHash} sent no Teleporter message`);
  const messageID = sentLog.topics[1] as Hex;
  console.log(`  + sent ${arg("amount")} to ${recipient} on chain ${peerChain}, message ${messageID}; waiting for the relayer`);
  for (let i = 0; i < 60; i++) {
    const received = await other.readContract({
      address: TELEPORTER_MESSENGER,
      abi: TELEPORTER_ABI,
      functionName: "messageReceived",
      args: [messageID],
    });
    if (received) {
      console.log(`  ✓ delivered: ${arg("amount")} ${toL1 ? "native CYBER minted" : "CYBER.sol released"} to ${recipient}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("not delivered after 5 minutes; check the ICM relayer");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const commands: Record<string, () => Promise<void>> = { vendor, home, registry, remote, register, collateral, send };
  const command = commands[process.argv[2]];
  if (!command) throw new Error(`usage: bridge.ts ${Object.keys(commands).join(" | ")} …`);
  await command();
}
