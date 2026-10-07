/**
 * Deploys CyberiaDomains — domain NFTs in `.cyber` and in every zone a
 * launchpad token opens — and moves the `.cyber` namespace over from
 * CyberiaNames (deployments/cyberia-names.json): its reserved names are
 * re-registered to the deployer with their records.
 *
 * Then it registers both launchpads and opens a zone for every token already
 * launched under a `.zone` / `DOTZONE` name, so the rule holds for launches
 * that predate the contract.
 *
 * Ethers with explicit gas limits (polygon-edge rejects eth_estimateGas for a
 * deployment), and nonces from `latest` only: the deployer is the shared
 * relayer EOA, and a `pending` read on this node can wedge it.
 *
 * Usage:
 *   npx hardhat compile && npx tsx scripts/deploy-domains.ts
 */
import "dotenv/config";
import { ethers } from "ethers";
import * as fs from "fs";

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK not set");
const pk = DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`;

const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const artifact = read("./artifacts/contracts/CyberiaDomains.sol/CyberiaDomains.json");
const namesArtifact = read("./artifacts/contracts/CyberiaNames.sol/CyberiaNames.json");
const native = read("./deployments/cyberia-launchpad-native.json");
const v3 = read("./deployments/cyberia-v3.json");
const oldNames = read("./deployments/cyberia-names.json");

const RPC_URL = process.env.CYBERIA_RPC_URL ?? "https://rpc.cyberia.church";
const PRICE = ethers.parseEther(process.env.DOMAINS_PRICE_CYBER ?? "1");
const OUT = "./deployments/cyberia-domains.json";

const network = new ethers.Network("cyberia", 49406);
const provider = new ethers.JsonRpcProvider(RPC_URL, network, { staticNetwork: network });
const wallet = new ethers.Wallet(pk, provider);
const nonce = () => provider.getTransactionCount(wallet.address, "latest");

async function send(label: string, fn: (o: { gasLimit: number; nonce: number }) => Promise<ethers.TransactionResponse>, gasLimit: number) {
  const tx = await fn({ gasLimit, nonce: await nonce() });
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`${label} reverted: ${tx.hash}`);
  console.log(`  ${label}`);
}

async function main() {
  console.log("Deploying CyberiaDomains…  owner", wallet.address);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const deployed = await factory.deploy(PRICE, { gasLimit: 6_000_000, nonce: await nonce() });
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  console.log("CyberiaDomains at", address);
  const domains = new ethers.Contract(address, artifact.abi, wallet);

  await send("launchpad native", (o) => domains.setLaunchpad(native.LaunchpadNative, 1, o), 150_000);
  await send("launchpad v3", (o) => domains.setLaunchpad(v3.LaunchpadV3, 2, o), 150_000);

  // .cyber moves over: the reserved names, with whatever records they carry.
  const names = new ethers.Contract(oldNames.address, namesArtifact.abi, provider);
  for (const label of oldNames.reserved as string[]) {
    await send(`reserved ${label}.cyber`, (o) => domains.registerFor(label, wallet.address, o), 300_000);
    const [keys, values] = (await names.records(label)) as [string[], string[]];
    if (keys.length) {
      await send(`  records ${keys.join(",")}`, (o) => domains.setRecords(label, "cyber", [...keys], [...values], o), 800_000);
    }
  }

  // Zones for launches that already happened.
  const zones: { zone: string; token: string }[] = [];
  for (const [pad, abi] of [
    [native.LaunchpadNative, ["function allTokensLength() view returns (uint256)", "function allTokens(uint256) view returns (address)"]],
    [v3.LaunchpadV3, ["function allTokensLength() view returns (uint256)", "function allTokens(uint256) view returns (address)"]],
  ] as const) {
    const c = new ethers.Contract(pad, abi, provider);
    const n = Number(await c.allTokensLength());
    for (let i = 0; i < n; i++) {
      const token = await c.allTokens(i);
      const meta = new ethers.Contract(token, ["function name() view returns (string)", "function symbol() view returns (string)"], provider);
      const [name, symbol] = await Promise.all([meta.name(), meta.symbol()]).catch(() => ["", ""]);
      const zone = await domains.zoneFromToken(name, symbol);
      if (!zone) continue;
      const [exists] = await domains.zone(zone);
      if (exists) continue;
      await send(`zone .${zone} ← ${token}`, (o) => domains.createZone(token, o), 400_000);
      zones.push({ zone, token });
    }
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        chainId: 49406,
        rpc: RPC_URL,
        _doc: "Domain NFTs: .cyber plus a zone per launchpad token named .<zone> / DOT<ZONE>. Served by services/cyberia-dns; supersedes cyberia-names.json.",
        address,
        owner: wallet.address,
        cyberPriceWei: PRICE.toString(),
        feeDivisor: "1000000",
        launchpads: { native: native.LaunchpadNative, v3: v3.LaunchpadV3 },
        reserved: oldNames.reserved,
        zones,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("wrote", OUT);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
