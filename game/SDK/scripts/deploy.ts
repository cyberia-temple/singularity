import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { artifacts, network } from "hardhat";
import { inspectDeployment } from "./deployment.js";

const phaseDuration = Number(process.env.ARENA_PHASE_DURATION ?? "300");
if (!Number.isSafeInteger(phaseDuration) || phaseDuration <= 0) {
  throw new Error("ARENA_PHASE_DURATION must be a positive integer");
}

const { ethers } = await network.connect({ network: "cyberia" });
if ((await ethers.provider.getNetwork()).chainId !== 49406n) {
  throw new Error("Expected Cyberia chain 49406");
}
await mkdir("deployments", { recursive: true });
const [deployer] = await ethers.getSigners();
if (!deployer) {
  throw new Error("Set CYBERIA_PRIVATE_KEY in game/SDK/.env before deployment");
}

console.log(
  `Deploying Cyberia Arena from ${deployer.address} (phase ${phaseDuration}s)`,
);
const arena = await ethers.deployContract("RockPaperScissors", [phaseDuration]);
const transaction = arena.deploymentTransaction();
if (!transaction) throw new Error("Deployment transaction is missing");
console.log(`ARENA_DEPLOYMENT_TX=${transaction.hash}`);
await arena.waitForDeployment();
const artifact = await artifacts.readArtifact("RockPaperScissors");
const manifest = await inspectDeployment(
  ethers.provider,
  transaction.hash,
  artifact.bytecode,
  BigInt(phaseDuration),
);
await writeFile(
  `deployments/cyberia-${manifest.address.toLowerCase()}.json`,
  JSON.stringify(manifest, null, 2) + "\n",
  { flag: "wx" },
);
console.log(`ARENA_CONTRACT_ADDRESS=${await arena.getAddress()}`);
