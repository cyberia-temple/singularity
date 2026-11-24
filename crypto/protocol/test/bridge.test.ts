import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { getAddress, parseEther } from "viem";

import { genesisSupply, remotePlan } from "../scripts/bridge.ts";

const MAINNET_REMOTE_DEPLOYER = getAddress("0xc9DeDDACFA05ed3967d1399745e76F47433452f9");
const MAINNET_MINTER = getAddress("0xD6753b71C47A20b044D8124B1a45da25C4521dF9");
const mainnetGenesis = () =>
  JSON.parse(fs.readFileSync(new URL("../../../services/avalanche-node/mainnet/genesis.json", import.meta.url), "utf8"));

const plan = (overrides: Partial<Parameters<typeof remotePlan>[0]> = {}) =>
  remotePlan({
    deployer: MAINNET_REMOTE_DEPLOYER,
    nonce: 0,
    implementationRecorded: false,
    genesisMinters: mainnetGenesis().config.contractNativeMinterConfig.enabledAddresses,
    minterOnChain: 1n,
    ...overrides,
  });

describe("bridge remote plan", () => {
  it("puts the proxy on the one address mainnet genesis lets mint", () => {
    assert.deepEqual(plan(), {
      implementation: getAddress("0xf12508241146300ACa5d5b9ad1ed1441a476EF7c"),
      proxy: MAINNET_MINTER,
      next: "implementation",
    });
    assert.equal(plan({ nonce: 1, implementationRecorded: true }).next, "proxy");
  });

  it("counts mainnet genesis' 1,100 CYBER as the reserve the home must back", () => {
    assert.equal(genesisSupply(mainnetGenesis()), parseEther("1100"));
  });

  it("stops when the deployer has sent anything else", () => {
    assert.throws(() => plan({ nonce: 1 }), /nonce 1 \(implementation not recorded\)/);
    assert.throws(() => plan({ nonce: 2, implementationRecorded: true }), /nonce 2/);
  });

  it("stops when the key is not the one genesis expects", () => {
    assert.throws(() => plan({ deployer: getAddress("0x197ad3f8c8948c7cffd3EF179838d221Aa40Ef61") }), /genesis lets/);
  });

  it("stops when the chain itself does not enable the minter", () => {
    assert.throws(() => plan({ minterOnChain: 0n }), /does not enable/);
  });
});
