/**
 * Deploys CyberiaVpnPass — days of Cyberia VPN sold for native CYBER.
 *
 * The payment is split in the purchase: VPN_FEE_BPS (default 10%) to the
 * protocol's fee address, the rest to VPN_TREASURY — the operators' side. Until
 * the VPN's ServiceTreasury exists that is the first node operator's own
 * address; `setTreasury` moves it later without touching a single pass.
 *
 * Usage:
 *   npx hardhat compile && npx tsx scripts/deploy-vpn-pass.ts
 *
 * env:
 *   DEPLOYER_PK         — deploys; becomes owner unless VPN_OWNER is set
 *   VPN_OWNER           — owner (price, split, pause); defaults to the deployer
 *   VPN_TREASURY        — operators' share; defaults to the deployer
 *   VPN_PRICE_PER_DAY   — CYBER per day, default 5
 *   VPN_FEE_BPS         — protocol share, default 1000 (10%), at most 2000
 *   VPN_FEE_RECIPIENT   — default 0x54BB8a86Fc001d5BB3e6C7ad2e2f153E5Fa6d7f6
 *   CYBERIA_RPC_URL     — defaults to https://rpc.cyberia.church
 *   EVM_CHAIN_ID        — defaults to 49406
 */
import "dotenv/config";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK not set");

const pk = DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`;
const artifact = JSON.parse(
  fs.readFileSync(
    "./artifacts/contracts/CyberiaVpnPass.sol/CyberiaVpnPass.json",
    "utf8",
  ),
);

const RPC_URL = process.env.CYBERIA_RPC_URL ?? "https://rpc.cyberia.church";
const CHAIN_ID = Number(process.env.EVM_CHAIN_ID ?? 49406);
const network = new ethers.Network("cyberia", CHAIN_ID);
const provider = new ethers.JsonRpcProvider(RPC_URL, network, {
  staticNetwork: network,
});
const wallet = new ethers.Wallet(pk, provider);

const FEE_RECIPIENT =
  process.env.VPN_FEE_RECIPIENT ?? "0x54BB8a86Fc001d5BB3e6C7ad2e2f153E5Fa6d7f6";

async function main() {
  const owner = process.env.VPN_OWNER ?? wallet.address;
  const treasury = process.env.VPN_TREASURY ?? wallet.address;
  const price = ethers.parseEther(process.env.VPN_PRICE_PER_DAY ?? "5");
  const feeBps = Number(process.env.VPN_FEE_BPS ?? 1000);

  console.log("Deploying CyberiaVpnPass...");
  console.log("  Owner:", owner);
  console.log("  Treasury:", treasury);
  console.log("  Fee:", feeBps, "bps to", FEE_RECIPIENT);
  console.log("  Price:", ethers.formatEther(price), "CYBER/day");

  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet,
  );

  // polygon-edge rejects eth_estimateGas for deployments, so the limit is stated.
  const contract = await factory.deploy(
    owner,
    price,
    feeBps,
    FEE_RECIPIENT,
    treasury,
    { gasLimit: 1_500_000 },
  );
  const tx = contract.deploymentTransaction();
  console.log("Transaction hash:", tx?.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await tx?.wait();

  const out = path.join("deployments", `cyberia-vpn-pass-${CHAIN_ID}.json`);
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        address,
        deployBlock: receipt?.blockNumber ?? null,
        tx: tx?.hash,
        owner,
        treasury,
        feeRecipient: FEE_RECIPIENT,
        feeBps,
        pricePerDayWei: price.toString(),
      },
      null,
      2,
    ) + "\n",
  );

  console.log("CyberiaVpnPass:", address, "block", receipt?.blockNumber);
  console.log("Written to", out);
  console.log("Next: VPN_PASS_ADDRESS and VPN_PASS_FROM_BLOCK in services/vpn/.env,");
  console.log("and VPN_PASS in resources/js/lib/wallet/vpn.ts.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
