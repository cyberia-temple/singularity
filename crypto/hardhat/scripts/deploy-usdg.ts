import "dotenv/config";
import { ethers } from "ethers";
import * as fs from "node:fs";

// Run from crypto/hardhat after compiling. The owner must be the bridge relayer.
const key = process.env.DEPLOYER_PK;
if (!key) throw new Error("DEPLOYER_PK not set");
const owner = process.env.USDG_OWNER;
if (!owner || !ethers.isAddress(owner) || owner === ethers.ZeroAddress) {
  throw new Error("USDG_OWNER must name the bridge relayer");
}
const registryPath = "deployments/cyberia-tokens.json";
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
if (registry.tokens.some((token: { symbol: string; address?: string }) => token.symbol === "USDG" && token.address)) {
  throw new Error("USDG already has a registered deployment");
}
const artifact = JSON.parse(fs.readFileSync("artifacts/contracts/USDG.sol/USDG.json", "utf8"));
const provider = new ethers.JsonRpcProvider(process.env.CYBERIA_RPC_URL ?? "https://rpc.cyberia.church");
if ((await provider.getNetwork()).chainId !== 49406n) throw new Error("Expected Cyberia chain 49406");
const wallet = new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`, provider);
if (await provider.getTransactionCount(wallet.address, "pending") !== await provider.getTransactionCount(wallet.address, "latest")) {
  throw new Error("Deployer has pending transactions; wait before deploying");
}
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
// polygon-edge cannot estimate contract creation (to: null).
const token = await factory.deploy(owner, { gasLimit: 2_000_000 });
console.log("USDG deployment transaction:", token.deploymentTransaction()!.hash);
const receipt = await token.deploymentTransaction()!.wait();
if (!receipt || receipt.status !== 1) throw new Error("USDG deployment failed");
const address = await token.getAddress();
const deployed = new ethers.Contract(address, artifact.abi, provider);
if ((await deployed.owner()).toLowerCase() !== owner.toLowerCase() || await deployed.decimals() !== 6n || await deployed.symbol() !== "USDG") {
  throw new Error("USDG deployment verification failed");
}
registry.tokens.push({ symbol: "USDG", contract: "USDG", artifact: "contracts/USDG.sol/USDG.json", address, burnable: true });
fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log("USDG deployed and verified:", address);
