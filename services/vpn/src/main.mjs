// Cyberia VPN node: index passes, keep Xray's client list equal to the set of
// running passes, and hand each paying address its link.

import { Contract, JsonRpcProvider, Network } from "ethers";
import { createGate, listen, NonceBook } from "./gate.mjs";
import { realityPublicKey, uuidFor, vlessLink } from "./identity.mjs";
import { activeAddresses, PASS_ABI, PassIndex } from "./passes.mjs";
import { buildConfig, XrayProcess } from "./xray.mjs";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
};

const config = {
  rpcUrl: env("VPN_RPC_URL", "https://rpc.cyberia.church"),
  chainId: Number(env("VPN_CHAIN_ID", "49406")),
  pass: env("VPN_PASS_ADDRESS"),
  fromBlock: Number(env("VPN_PASS_FROM_BLOCK", "0")),
  secret: env("VPN_CLIENT_SECRET"),
  host: env("VPN_PUBLIC_HOST"),
  port: Number(env("VPN_PORT", "443")),
  nodeId: env("VPN_NODE_ID", process.env.VPN_PUBLIC_HOST),
  dest: env("VPN_REALITY_DEST", "www.microsoft.com:443"),
  serverName: env("VPN_REALITY_SERVER_NAME", "www.microsoft.com"),
  privateKey: env("VPN_REALITY_PRIVATE_KEY"),
  shortId: env("VPN_REALITY_SHORT_ID"),
  gatePort: Number(env("VPN_GATE_PORT", "8780")),
  xray: env("VPN_XRAY_BIN", "/usr/local/bin/xray"),
  dataDir: env("VPN_DATA_DIR", "/data"),
  pollSeconds: Number(env("VPN_POLL_SECONDS", "30")),
};

if (config.secret.length < 32) {
  throw new Error("VPN_CLIENT_SECRET must be at least 32 characters");
}

const network = new Network("cyberia", config.chainId);
const provider = new JsonRpcProvider(config.rpcUrl, network, { staticNetwork: network });
const contract = new Contract(config.pass, PASS_ABI, provider);
const publicKey = realityPublicKey(config.privateKey);
const index = new PassIndex({
  provider,
  address: config.pass,
  fromBlock: config.fromBlock,
  statePath: `${config.dataDir}/passes.json`,
});
const xray = new XrayProcess({ binary: config.xray, configPath: `${config.dataDir}/xray.json` });

let applied = null;

/** Rewrite Xray only when the set of running passes actually changed. */
function reconcile() {
  const active = activeAddresses(index.expiries, Math.floor(Date.now() / 1000));
  const key = active.join(",");
  if (key === applied) {
    return;
  }
  xray.apply(
    buildConfig({
      port: config.port,
      dest: config.dest,
      serverName: config.serverName,
      privateKey: config.privateKey,
      shortId: config.shortId,
      clients: active.map((address) => ({ id: uuidFor(config.secret, address), email: address })),
    }),
  );
  applied = key;
  console.log(`xray: ${active.length} active pass(es)`);
}

async function tick() {
  try {
    await index.sync();
  } catch (error) {
    // A chain that cannot be read keeps the last known set: passes already
    // paid for keep working, and nobody new is let in on a guess.
    console.error("passes:", error?.shortMessage ?? error?.message ?? error);
  }
  reconcile();
}

const gate = createGate({
  node: {
    id: config.nodeId,
    host: config.host,
    port: config.port,
    protocol: "vless-reality",
    serverName: config.serverName,
    publicKey,
    chainId: config.chainId,
    pass: config.pass,
  },
  nonces: new NonceBook(),
  // The index may be one poll behind a purchase made a second ago, so a miss
  // asks the contract itself, and a hit lets the address in right away.
  passUntil: async (address) => {
    const known = index.expiries[address] ?? 0;
    if (known * 1000 > Date.now()) {
      return known;
    }
    const live = Number(await contract.expiresAt(address));
    if (live > known) {
      index.expiries[address] = live;
      reconcile();
    }
    return live;
  },
  linkFor: (address) =>
    vlessLink({
      uuid: uuidFor(config.secret, address),
      host: config.host,
      port: config.port,
      serverName: config.serverName,
      publicKey,
      shortId: config.shortId,
      label: `Cyberia ${config.nodeId}`,
    }),
});

await tick();
await listen(gate, config.gatePort);
console.log(`gate: :${config.gatePort}, node ${config.nodeId}, pass ${config.pass}`);
setInterval(tick, config.pollSeconds * 1000);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    xray.stop();
    process.exit(0);
  });
}
