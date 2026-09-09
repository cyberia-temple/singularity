import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { artifacts, network } from "hardhat";
import { inspectDeployment } from "./deployment.js";

const transactionHash = process.env.ARENA_DEPLOYMENT_TX;
if (!transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash))
  throw new Error(
    "Set ARENA_DEPLOYMENT_TX to the contract creation transaction",
  );
const version = process.env.ARENA_RULES_VERSION ?? "2";
if (version !== "1" && version !== "2")
  throw new Error("ARENA_RULES_VERSION must be 1 or 2");
const treasury =
  version === "2" ? process.env.ARENA_TREASURY_ADDRESS : undefined;
if (version === "2" && !treasury)
  throw new Error("Set ARENA_TREASURY_ADDRESS for asynchronous Arena");
const phaseDuration =
  version === "2" ? 600n : BigInt(process.env.ARENA_PHASE_DURATION ?? "300");
const { ethers } = await network.connect({ network: "cyberia" });
const artifact = await artifacts.readArtifact(
  version === "2" ? "RockPaperScissorsAsync" : "RockPaperScissors",
);
const manifest = await inspectDeployment(
  ethers.provider,
  transactionHash,
  artifact.bytecode,
  phaseDuration,
  treasury,
);
await mkdir("deployments", { recursive: true });
const path = `deployments/cyberia-${manifest.address.toLowerCase()}.json`;
await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(`Verified deployment; manifest saved to ${path}`);
console.log(
  "Explorer source verification and a two-wallet smoke match remain separate checks.",
);
