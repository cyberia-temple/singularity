import { rejects } from "node:assert/strict";
import { expect } from "chai";
import { artifacts, network } from "hardhat";
import { inspectDeployment } from "../scripts/deployment.js";

const { ethers } = await network.create({ override: { chainId: 49406 } });

async function deployed() {
  const arena = await ethers.deployContract("RockPaperScissors", [300]);
  await arena.waitForDeployment();
  const hash = arena.deploymentTransaction()!.hash;
  const artifact = await artifacts.readArtifact("RockPaperScissors");
  return { arena, hash, artifact };
}

describe("Arena deployment verification", function () {
  it("records a mined deployment only when the build and constructor match", async function () {
    const { arena, hash, artifact } = await deployed();
    const manifest = await inspectDeployment(
      ethers.provider,
      hash,
      artifact.bytecode,
      300n,
    );
    expect(manifest.address).to.equal(await arena.getAddress());
    expect(manifest.transactionHash).to.equal(hash);
    expect(manifest.runtimeBytecodeHash).to.equal(
      ethers.keccak256(await ethers.provider.getCode(manifest.address)),
    );
    expect(manifest.constructorArguments).to.deep.equal(["300"]);
  });

  it("refuses a different constructor or build", async function () {
    const { hash, artifact } = await deployed();
    for (const [code, duration] of [
      [artifact.bytecode, 301n],
      ["0x00", 300n],
    ] as const) {
      await rejects(
        inspectDeployment(ethers.provider, hash, code, duration),
        /Deployment input does not match/,
      );
    }
  });

  it("refuses missing transactions and ordinary transfers", async function () {
    const { artifact } = await deployed();
    await rejects(
      inspectDeployment(
        ethers.provider,
        ethers.ZeroHash,
        artifact.bytecode,
        300n,
      ),
      /confirmed successful contract deployment/,
    );
    const [sender, recipient] = await ethers.getSigners();
    const tx = await sender.sendTransaction({
      to: recipient.address,
      value: 1n,
    });
    await tx.wait();
    await rejects(
      inspectDeployment(ethers.provider, tx.hash, artifact.bytecode, 300n),
      /confirmed successful contract deployment/,
    );
  });

  it("refuses a deployment on another chain", async function () {
    const other = await network.create();
    await rejects(
      inspectDeployment(other.ethers.provider, ethers.ZeroHash, "0x", 300n),
      /Expected Cyberia chain 49406/,
    );
  });
});
