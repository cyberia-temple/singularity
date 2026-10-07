import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEther, toFunctionSelector, zeroAddress } from "viem";
import { network } from "hardhat";

/**
 * CyberiaNames: the `.cyber` registry services/cyberia-dns answers from.
 * Covers what decides who controls an answer — label validity, the fee,
 * ownership and transfer — and the record store's add/overwrite/delete.
 */
describe("CyberiaNames", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob] = await viem.getWalletClients();
  const PRICE = parseEther("1");

  async function deploy() {
    const names = await viem.deployContract("CyberiaNames", [PRICE]);
    const as = (client: typeof alice) =>
      viem.getContractAt("CyberiaNames", names.address, { client: { wallet: client } });
    return { names, as };
  }

  it("keeps the resolve() selector services/cyberia-dns hardcodes", function () {
    assert.equal(toFunctionSelector("function resolve(string,string[])"), "0x1920a87e");
  });

  it("accepts only DNS hostname labels", async function () {
    const { names } = await deploy();
    for (const ok of ["a", "lain", "x-1", "0", "a".repeat(63)]) {
      assert.equal(await names.read.validLabel([ok]), true, ok);
    }
    for (const bad of ["", "-a", "a-", "Lain", "a.b", "a_b", "a".repeat(64), "лейн"]) {
      assert.equal(await names.read.validLabel([bad]), false, bad);
    }
  });

  it("registers for exactly the price and refuses a taken name", async function () {
    const { names, as } = await deploy();
    const a = await as(alice);

    await assert.rejects(a.write.register(["lain"], { value: PRICE - 1n }), /wrong price/);
    await a.write.register(["lain"], { value: PRICE });

    assert.equal(
      (await names.read.ownerOfName(["lain"])).toLowerCase(),
      alice.account.address.toLowerCase(),
    );
    assert.equal(await names.read.available(["lain"]), false);
    assert.equal(await publicClient.getBalance({ address: names.address }), PRICE);

    const b = await as(bob);
    await assert.rejects(b.write.register(["lain"], { value: PRICE }), /name taken/);
    await assert.rejects(b.write.register(["Lain"], { value: PRICE }), /invalid label/);
  });

  it("lets the owner reserve names free and withdraw fees", async function () {
    const { names, as } = await deploy();
    await names.write.registerFor(["dns", deployer.account.address]);
    await assert.rejects((await as(alice)).write.registerFor(["x", alice.account.address]), /Ownable/);

    await (await as(alice)).write.register(["paid"], { value: PRICE });
    const before = await publicClient.getBalance({ address: bob.account.address });
    await names.write.withdraw([bob.account.address]);
    assert.equal(await publicClient.getBalance({ address: bob.account.address }), before + PRICE);

    await names.write.setPrice([0n]);
    await (await as(bob)).write.register(["free"], { value: 0n });
  });

  it("writes, overwrites, deletes and resolves records", async function () {
    const { names, as } = await deploy();
    const a = await as(alice);
    await a.write.register(["lain"], { value: PRICE });

    await a.write.setRecords(["lain", ["A", "TXT", "www/A"], ["1.2.3.4", "hello", "5.6.7.8"]]);
    await a.write.setRecord(["lain", "A", "9.9.9.9"]);
    await a.write.setRecord(["lain", "TXT", ""]);

    const [keys, values] = await names.read.records(["lain"]);
    const map = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
    assert.deepEqual(map, { A: "9.9.9.9", "www/A": "5.6.7.8" });

    const [owner, got] = await names.read.resolve(["lain", ["A", "TXT", "AAAA"]]);
    assert.equal(owner.toLowerCase(), alice.account.address.toLowerCase());
    assert.deepEqual(got, ["9.9.9.9", "", ""]);

    const [nobody] = await names.read.resolve(["ghost", ["A"]]);
    assert.equal(nobody, zeroAddress);

    await assert.rejects((await as(bob)).write.setRecord(["lain", "A", "6.6.6.6"]), /not name owner/);
  });

  it("transfers control of the records with the name", async function () {
    const { as } = await deploy();
    const a = await as(alice);
    const b = await as(bob);
    await a.write.register(["lain"], { value: PRICE });
    await a.write.transfer(["lain", bob.account.address]);

    await assert.rejects(a.write.setRecord(["lain", "A", "1.1.1.1"]), /not name owner/);
    await b.write.setRecord(["lain", "A", "1.1.1.1"]);
  });
});
