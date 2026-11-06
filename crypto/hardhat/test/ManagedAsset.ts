import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

describe("ManagedAsset", async () => {
  const { viem } = await network.connect();
  const [deployer, holder, outsider] = await viem.getWalletClients();

  it("deploys a named stock representation with configurable decimals and no premint", async () => {
    const token = await viem.deployContract("ManagedAsset", [
      "Sberbank Shares", "SBER", 2, deployer.account.address,
    ]);
    assert.equal(await token.read.name(), "Sberbank Shares");
    assert.equal(await token.read.symbol(), "SBER");
    assert.equal(await token.read.decimals(), 2);
    assert.equal(await token.read.totalSupply(), 0n);
    assert.equal(String(await token.read.owner()).toLowerCase(), deployer.account.address.toLowerCase());

    await token.write.mint([holder.account.address, 125n]);
    assert.equal(await token.read.balanceOf([holder.account.address]), 125n);
    await assert.rejects(token.write.mint([holder.account.address, 1n], { account: outsider.account }));

    // As with the established Cyberia wrappers, the owner may burn without allowance.
    await token.write.burnFrom([holder.account.address, 25n]);
    assert.equal(await token.read.balanceOf([holder.account.address]), 100n);
    assert.equal(await token.read.totalSupply(), 100n);
  });

  it("supports standard allowance-based burns for non-owners", async () => {
    const token = await viem.deployContract("ManagedAsset", [
      "Share Receipt", "SHARE", 0, deployer.account.address,
    ]);
    await token.write.mint([holder.account.address, 5n]);
    await assert.rejects(
      token.write.burnFrom([holder.account.address, 1n], { account: outsider.account }),
    );
    await token.write.approve([outsider.account.address, 2n], { account: holder.account });
    await token.write.burnFrom([holder.account.address, 2n], { account: outsider.account });
    assert.equal(await token.read.balanceOf([holder.account.address]), 3n);
  });

  it("rejects bad metadata, decimals and owner", async () => {
    for (const args of [
      ["", "SHARE", 2, deployer.account.address],
      ["Share", "", 2, deployer.account.address],
      ["Share", "SHARE", 19, deployer.account.address],
      ["Share", "SHARE", 2, "0x0000000000000000000000000000000000000000"],
    ] as const) {
      await assert.rejects(viem.deployContract("ManagedAsset", [...args]));
    }
  });
});
