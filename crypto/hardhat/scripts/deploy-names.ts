/**
 * Deploys CyberiaNames (the `.cyber` namespace services/cyberia-dns answers
 * from) to Cyberia and reserves the project's own names to the deployer.
 *
 * Ethers rather than viem for the same reason as deploy-profile.ts: the
 * polygon-edge JSON-RPC rejects eth_estimateGas for deployments, so every
 * transaction carries an explicit gas limit. Nonces come from `latest` only:
 * this deployer is the shared relayer EOA, and a `pending` read on Cyberia's
 * node answers from a pool counter that never rolls back (one bad read can
 * wedge the bridge, the minter and the bot at once).
 *
 * Usage:
 *   npx hardhat compile && npx tsx scripts/deploy-names.ts
 *   NAMES_PRICE_CYBER=1 NAMES_RESERVE=cyberia,lain,dns,www ...
 */
import "dotenv/config";
import { ethers } from "ethers";
import * as fs from "fs";

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK not set");

const pk = DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`;
const artifact = JSON.parse(
  fs.readFileSync("./artifacts/contracts/CyberiaNames.sol/CyberiaNames.json", "utf8"),
);

const RPC_URL = process.env.CYBERIA_RPC_URL ?? "https://rpc.cyberia.church";
const PRICE = ethers.parseEther(process.env.NAMES_PRICE_CYBER ?? "1");
const RESERVE = (process.env.NAMES_RESERVE ?? "cyberia,lain,dns,www,wallet,bridge,swap")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = "./deployments/cyberia-names.json";

const network = new ethers.Network("cyberia", 49406);
const provider = new ethers.JsonRpcProvider(RPC_URL, network, { staticNetwork: network });
const wallet = new ethers.Wallet(pk, provider);

async function main() {
  console.log("Deploying CyberiaNames…");
  console.log("  owner:", wallet.address);
  console.log("  price:", ethers.formatEther(PRICE), "CYBER");

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const nonce = () => provider.getTransactionCount(wallet.address, "latest");
  const contract = await factory.deploy(PRICE, { gasLimit: 3_000_000, nonce: await nonce() });
  console.log("  tx:", contract.deploymentTransaction()?.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("CyberiaNames at", address);

  const names = new ethers.Contract(address, artifact.abi, wallet);
  for (const label of RESERVE) {
    if (!(await names.available(label))) continue;
    const tx = await names.registerFor(label, wallet.address, { gasLimit: 200_000, nonce: await nonce() });
    await tx.wait();
    console.log(`  reserved ${label}.cyber`);
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        chainId: 49406,
        rpc: RPC_URL,
        _doc: "The .cyber namespace: names + string records, answered as DNS by services/cyberia-dns.",
        address,
        owner: wallet.address,
        priceWei: PRICE.toString(),
        reserved: RESERVE,
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
