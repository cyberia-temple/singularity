import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEther } from "viem";
import { network } from "hardhat";

/**
 * CyberiaShop: digital goods through escrow. Covers the money paths — a
 * confirmed sale with the fee, a release after the dispute window, a refund
 * when nothing was delivered, a moderator's split, an escrowed NFT travelling
 * with the sale — and the moderation that stops new sales without trapping
 * paid orders.
 */
describe("CyberiaShop", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [owner, seller, buyer, other, feeTo] = await viem.getWalletClients();

  const HOUR = 3600n;
  const DELIVERY = 48n * HOUR;
  const DISPUTE = 72n * HOUR;
  const KEY = `0x02${"11".repeat(32)}` as const;
  const ENVELOPE = "0xdeadbeef" as const;
  const PRICE = parseEther("10");
  const NONE = "0x0000000000000000000000000000000000000000" as const;

  async function deploy() {
    const shop = await viem.deployContract("CyberiaShop", [
      owner.account.address,
      feeTo.account.address,
      200,
      DELIVERY,
      DISPUTE,
    ]);
    const as = (client: typeof seller) =>
      viem.getContractAt("CyberiaShop", shop.address, { client: { wallet: client } });
    return { shop, as };
  }

  async function warp(seconds: bigint) {
    await testClient.increaseTime({ seconds: Number(seconds) });
    await testClient.mine({ blocks: 1 });
  }

  const balance = (address: `0x${string}`) => publicClient.getBalance({ address });

  async function listAndBuy(as: Awaited<ReturnType<typeof deploy>>["as"], stock = 2) {
    await (await as(seller)).write.list([NONE, PRICE, stock, 0, KEY, "ipfs://lot", NONE, 0n]);
    await (await as(buyer)).write.buy([0n, KEY, PRICE], { value: PRICE });
  }

  it("holds the payment until the buyer confirms, then pays the seller less 2%", async function () {
    const { shop, as } = await deploy();
    await listAndBuy(as);
    const sellerBefore = await balance(seller.account.address);
    const feeBefore = await balance(feeTo.account.address);

    await (await as(seller)).write.deliver([0n, ENVELOPE]);
    const order = await shop.read.getOrder([0n]);
    const logs = await publicClient.getContractEvents({
      address: shop.address,
      abi: shop.abi,
      eventName: "Delivered",
      fromBlock: order.deliveredBlock,
      toBlock: order.deliveredBlock,
    });
    assert.equal(logs[0].args.envelope, ENVELOPE);

    await (await as(buyer)).write.confirm([0n]);
    assert.equal(await balance(feeTo.account.address) - feeBefore, PRICE / 50n);
    // The seller paid gas for deliver, so compare against an upper bound.
    const got = (await balance(seller.account.address)) - sellerBefore;
    assert.ok(got > parseEther("9.79") && got <= (PRICE * 98n) / 100n);
    assert.equal((await shop.read.getListing([0n])).stock, 1);
  });

  it("lets anyone release after the dispute window and nobody before", async function () {
    const { as } = await deploy();
    await listAndBuy(as);
    await (await as(seller)).write.deliver([0n, ENVELOPE]);
    await assert.rejects((await as(other)).write.release([0n]), /dispute window open/);
    await warp(DISPUTE);
    await (await as(other)).write.release([0n]);
    await assert.rejects((await as(buyer)).write.dispute([0n]), /not delivered/);
  });

  it("refunds in full when the seller never delivers", async function () {
    const { as } = await deploy();
    await listAndBuy(as);
    await assert.rejects((await as(buyer)).write.refund([0n]), /still has time/);
    await warp(DELIVERY);
    const feeBefore = await balance(feeTo.account.address);
    await (await as(buyer)).write.refund([0n]);
    assert.equal(await balance(feeTo.account.address), feeBefore);
    await assert.rejects((await as(seller)).write.deliver([0n, ENVELOPE]), /not awaiting delivery/);
  });

  it("splits a disputed order by a moderator's decision, fee only on the seller's part", async function () {
    const { shop, as } = await deploy();
    await listAndBuy(as);
    await (await as(seller)).write.deliver([0n, ENVELOPE]);
    await (await as(buyer)).write.dispute([0n]);
    await assert.rejects((await as(other)).write.release([0n]), /not releasable/);
    await assert.rejects((await as(other)).write.resolve([0n, 5000]), /not moderator/);

    await shop.write.setModerator([other.account.address, true]);
    const buyerBefore = await balance(buyer.account.address);
    const feeBefore = await balance(feeTo.account.address);
    await (await as(other)).write.resolve([0n, 5000]);
    assert.equal(await balance(buyer.account.address) - buyerBefore, PRICE / 2n);
    assert.equal(await balance(feeTo.account.address) - feeBefore, PRICE / 2n / 50n);
  });

  it("escrows an NFT and hands it to the buyer with the release, in an ERC-20 lot", async function () {
    const { shop, as } = await deploy();
    const nft = await viem.deployContract("CyberiaNFT", [], { client: { wallet: seller } });
    await nft.write.mint(["ipfs://domain"]);
    const tokenId = 1n;
    const token = await viem.deployContract("MockZoneToken", ["USD", "USD", PRICE, buyer.account.address]);

    await nft.write.approve([shop.address, tokenId]);
    await assert.rejects(
      (await as(seller)).write.list([token.address, PRICE, 2, 4, KEY, "ipfs://lot", nft.address, tokenId]),
      /one unit/,
    );
    await (await as(seller)).write.list([token.address, PRICE, 1, 4, KEY, "ipfs://lot", nft.address, tokenId]);
    assert.equal((await nft.read.ownerOf([tokenId])).toLowerCase(), shop.address.toLowerCase());

    const tokenAsBuyer = await viem.getContractAt("MockZoneToken", token.address, { client: { wallet: buyer } });
    await tokenAsBuyer.write.approve([shop.address, PRICE]);
    await (await as(buyer)).write.buy([0n, KEY, PRICE]);
    await (await as(seller)).write.deliver([0n, ENVELOPE]);
    await (await as(buyer)).write.confirm([0n]);

    assert.equal((await nft.read.ownerOf([tokenId])).toLowerCase(), buyer.account.address.toLowerCase());
    assert.equal(await token.read.balanceOf([seller.account.address]), (PRICE * 98n) / 100n);
    assert.equal(await token.read.balanceOf([feeTo.account.address]), PRICE / 50n);
  });

  it("hides a lot after three buyers report it, and paid orders still settle", async function () {
    const { shop, as } = await deploy();
    const [, , , , , b2, b3] = await viem.getWalletClients();
    await (await as(seller)).write.list([NONE, PRICE, 5, 2, KEY, "ipfs://lot", NONE, 0n]);
    await assert.rejects((await as(other)).write.report([0n, "spam"]), /buyers only/);
    for (const b of [buyer, b2, b3]) {
      await (await as(b)).write.buy([0n, KEY, PRICE], { value: PRICE });
      await (await as(b)).write.report([0n, "stolen account"]);
    }
    assert.equal((await shop.read.getListing([0n])).hidden, true);
    await assert.rejects((await as(other)).write.buy([0n, KEY, PRICE], { value: PRICE }), /not for sale/);

    await shop.write.setBanned([seller.account.address, true]);
    await assert.rejects(
      (await as(seller)).write.list([NONE, PRICE, 1, 0, KEY, "ipfs://x", NONE, 0n]),
      /banned/,
    );
    await (await as(seller)).write.sellerRefund([0n]);
    await warp(DELIVERY);
    await (await as(b2)).write.refund([1n]);
  });

  it("refuses a purchase above the price the buyer agreed to", async function () {
    const { as } = await deploy();
    await (await as(seller)).write.list([NONE, PRICE, 1, 0, KEY, "ipfs://lot", NONE, 0n]);
    await (await as(seller)).write.update([0n, PRICE * 2n, 1]);
    await assert.rejects((await as(buyer)).write.buy([0n, KEY, PRICE], { value: PRICE }), /price changed/);
    await assert.rejects((await as(buyer)).write.buy([0n, KEY, PRICE * 2n], { value: PRICE }), /wrong value/);
  });
});
