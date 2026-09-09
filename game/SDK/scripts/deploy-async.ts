import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { getAddress, ZeroAddress } from "ethers";
import { artifacts, network } from "hardhat";
import { inspectDeployment } from "./deployment.js";

if (!process.env.ARENA_TREASURY_ADDRESS)
  throw new Error("Set ARENA_TREASURY_ADDRESS before deployment");
const treasury = getAddress(process.env.ARENA_TREASURY_ADDRESS);
if (treasury === ZeroAddress) throw new Error("Treasury cannot be zero");
const { ethers } = await network.create({ network: "cyberia" });
if ((await ethers.provider.getNetwork()).chainId !== 49406n)
  throw new Error("Expected Cyberia chain 49406");
await mkdir("deployments", { recursive: true });
const [deployer] = await ethers.getSigners();
if (!deployer) throw new Error("Set CYBERIA_PRIVATE_KEY before deployment");
console.log(
  `Deploying asynchronous Arena from ${deployer.address}; treasury ${treasury}; phases 600s`,
);
const arena = await ethers.deployContract("RockPaperScissorsAsync", [treasury]);
const transaction = arena.deploymentTransaction();
if (!transaction) throw new Error("Deployment transaction is missing");
console.log(`ARENA_DEPLOYMENT_TX=${transaction.hash}`);
await arena.waitForDeployment();
const artifact = await artifacts.readArtifact("RockPaperScissorsAsync");
const manifest = await inspectDeployment(
  ethers.provider,
  transaction.hash,
  artifact.bytecode,
  600n,
  treasury,
);
await writeFile(
  `deployments/cyberia-${manifest.address.toLowerCase()}.json`,
  JSON.stringify(manifest, null, 2) + "\n",
  { flag: "wx" },
);
console.log(`ARENA_CONTRACT_ADDRESS=${manifest.address}`);
