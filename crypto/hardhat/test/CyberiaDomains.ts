import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEther, toFunctionSelector, zeroAddress } from "viem";
import { network } from "hardhat";

/**
 * CyberiaDomains: domain NFTs in zones that launchpad tokens open. Covers what
 * decides who controls an answer — which tokens may open which zone, what a
 * name costs and where that payment goes, NFT ownership as record ownership —
 * and the selectors services/cyberia-dns hardcodes.
 */
describe("CyberiaDomains", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob] = await viem.getWalletClients();
  const PRICE = parseEther("1");
  const SUPPLY = parseEther("1000000000");
  const BURN = "0x000000000000000000000000000000000000dEaD";

  async function deploy() {
    const domains = await viem.deployContract("CyberiaDomains", [PRICE]);
    const pairPad = await viem.deployContract("MockPairLaunchpad", []);
    const poolPad = await viem.deployContract("MockPoolLaunchpad", []);
    await domains.write.setLaunchpad([pairPad.address, 1]);
    await domains.write.setLaunchpad([poolPad.address, 2]);
    const as = (client: typeof alice) =>
      viem.getContractAt("CyberiaDomains", domains.address, { client: { wallet: client } });

    const token = async (name: string, symbol: string, pad: typeof pairPad | typeof poolPad | null = pairPad) => {
      const t = await viem.deployContract("MockZoneToken", [name, symbol, SUPPLY, alice.account.address]);
      if (pad) await pad.write.list([t.address]);
      return t;
    };
    return { domains, as, token, pairPad, poolPad };
  }

  it("keeps the selectors services/cyberia-dns hardcodes", function () {
    assert.equal(toFunctionSelector("function resolve(string,string,string[])"), "0xd1ab368c");
    assert.equal(toFunctionSelector("function zones()"), "0x03d25049");
  });

  it("reads a zone out of a name and ticker, folding case", async function () {
    const { domains } = await deploy();
    const z = (n: string, s: string) => domains.read.zoneFromToken([n, s]);
    assert.equal(await z(".moon", "DOTMOON"), "moon");
    assert.equal(await z(".Moon", "DotMoon"), "moon");
    assert.equal(await z(".my-zone", "DOTMY-ZONE"), "my-zone");
    for (const [n, s] of [["moon", "DOTMOON"], [".moon", "MOON"], [".moon", "DOTMARS"], [".mo on", "DOTMO ON"], [".", "DOT"], [".-x", "DOT-X"]]) {
      assert.equal(await z(n, s), "", `${n}/${s}`);
    }
  });

  it("opens a zone only for a launchpad token that spells one, once", async function () {
    const { domains, token, poolPad } = await deploy();

    const unlisted = await token(".moon", "DOTMOON", null);
    await assert.rejects(domains.write.createZone([unlisted.address]), /not a launchpad token/);

    const wrong = await token("Moon", "MOON");
    await assert.rejects(domains.write.createZone([wrong.address]), /not a zone token/);

    const moon = await token(".moon", "DOTMOON", poolPad);
    await domains.write.createZone([moon.address]);
    assert.equal(await domains.read.zoneOfToken([moon.address]), "moon");
    await assert.rejects(domains.write.createZone([moon.address]), /zone exists/);

    const copy = await token(".MOON", "DOTMOON");
    await assert.rejects(domains.write.createZone([copy.address]), /zone taken/);

    const root = await token(".cyber", "DOTCYBER");
    await assert.rejects(domains.write.createZone([root.address]), /zone taken/);

    const [labels, tokens] = await domains.read.zones();
    assert.deepEqual(labels, ["cyber", "moon"]);
    assert.deepEqual(tokens, [zeroAddress, getAddress(moon.address)]);
  });

  it("sells root names for CYBER and token-zone names for burned zone tokens", async function () {
    const { domains, as, token } = await deploy();
    const a = await as(alice);

    await assert.rejects(a.write.register(["lain", "cyber"], { value: PRICE - 1n }), /wrong price/);
    await a.write.register(["lain", "cyber"], { value: PRICE });
    assert.equal(await publicClient.getBalance({ address: domains.address }), PRICE);
    await assert.rejects((await as(bob)).write.register(["lain", "cyber"], { value: PRICE }), /name taken/);

    const moon = await token(".moon", "DOTMOON");
    await domains.write.createZone([moon.address]);
    const fee = SUPPLY / 1_000_000n;
    const [, , , quoted] = await domains.read.zone(["moon"]);
    assert.equal(quoted, fee);

    await assert.rejects(a.write.register(["lain", "moon"], { value: 1n }), /pay in the zone token/);
    await assert.rejects(a.write.register(["lain", "moon"]));
    const t = await viem.getContractAt("MockZoneToken", moon.address, { client: { wallet: alice } });
    await t.write.approve([domains.address, fee]);
    await a.write.register(["lain", "moon"]);
    assert.equal(await t.read.balanceOf([BURN]), fee);
    assert.equal(await t.read.balanceOf([alice.account.address]), SUPPLY - fee);

    await assert.rejects(a.write.register(["x", "mars"], { value: PRICE }), /no such zone/);
    await assert.rejects(a.write.register(["Bad", "cyber"], { value: PRICE }), /invalid label/);
  });

  it("is an NFT: the holder writes the records, a transfer hands them over", async function () {
    const { domains, as } = await deploy();
    const a = await as(alice);
    await a.write.register(["site", "cyber"], { value: PRICE });
    const id = await domains.read.tokenIdOf(["site", "cyber"]);

    assert.equal((await domains.read.ownerOf([id])).toLowerCase(), alice.account.address.toLowerCase());
    await a.write.setRecords(["site", "cyber", ["A", "www/CNAME"], ["1.2.3.4", "site.cyber"]]);
    await a.write.setRecords(["site", "cyber", ["A"], [""]]);
    const [keys, values] = await domains.read.records(["site", "cyber"]);
    assert.deepEqual([keys, values], [["www/CNAME"], ["site.cyber"]]);

    await a.write.transferFrom([alice.account.address, bob.account.address, id]);
    await assert.rejects(a.write.setRecords(["site", "cyber", ["A"], ["6.6.6.6"]]), /not domain owner/);
    await (await as(bob)).write.setRecords(["site", "cyber", ["A"], ["1.1.1.1"]]);

    const [owner, got] = await domains.read.resolve(["site", "cyber", ["A", "TXT"]]);
    assert.equal(owner.toLowerCase(), bob.account.address.toLowerCase());
    assert.deepEqual(got, ["1.1.1.1", ""]);

    const [nobody] = await domains.read.resolve(["ghost", "cyber", ["A"]]);
    assert.equal(nobody, zeroAddress);
  });

  it("draws its own metadata on chain", async function () {
    const { domains, as } = await deploy();
    await (await as(alice)).write.register(["lain", "cyber"], { value: PRICE });
    const uri = await domains.read.tokenURI([await domains.read.tokenIdOf(["lain", "cyber"])]);
    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    assert.equal(json.name, "lain.cyber");
    assert.match(Buffer.from(json.image.split(",")[1], "base64").toString(), /lain\.cyber/);
  });

  it("lets the owner reserve root names, block a zone and withdraw, but not hand out token zones", async function () {
    const { domains, as, token } = await deploy();
    await domains.write.registerFor(["dns", deployer.account.address]);
    await assert.rejects((await as(alice)).write.registerFor(["x", alice.account.address]), /Ownable/);

    const moon = await token(".moon", "DOTMOON");
    await domains.write.createZone([moon.address]);
    await domains.write.blockZone(["moon", true]);
    assert.equal(await domains.read.available(["any", "moon"]), false);
    await assert.rejects((await as(alice)).write.register(["any", "moon"]), /zone blocked/);

    await (await as(alice)).write.register(["paid", "cyber"], { value: PRICE });
    const before = await publicClient.getBalance({ address: bob.account.address });
    await domains.write.withdraw([bob.account.address]);
    assert.equal(await publicClient.getBalance({ address: bob.account.address }), before + PRICE);
  });
});
