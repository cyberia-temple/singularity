import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, parseEther } from "viem";

import { build, check, predictRemote, REPLAY_FLOOR_WEI } from "../scripts/genesis.ts";

const REMOTE_DEPLOYER = getAddress("0x2772608422d4De3C2F4fCEa038e879f4D39877A1");
const OPERATOR = getAddress("0xae8F9c21b082d09857622824ADA365D71b18B44B");

function fuji() {
  return build({
    network: "fuji",
    remoteDeployer: REMOTE_DEPLOYER,
    operator: OPERATOR,
    feeAdmin: OPERATOR,
    remoteGas: parseEther("100000"),
    operatorGas: parseEther("1000000"),
    timestamp: 1_790_000_000,
  });
}

describe("genesis", () => {
  it("lets only the remote's proxy mint and counts every genesis coin as owed collateral", () => {
    const genesis = fuji();
    assert.deepEqual(genesis.config.contractNativeMinterConfig.enabledAddresses, [predictRemote(REMOTE_DEPLOYER)]);
    assert.equal(check(genesis, REMOTE_DEPLOYER), parseEther("1100000"));
  });

  it("refuses a minter other than the remote", () => {
    const genesis = fuji();
    genesis.config.contractNativeMinterConfig.enabledAddresses.push(OPERATOR);
    assert.throws(() => check(genesis, REMOTE_DEPLOYER), /exactly the remote/);
  });

  it("refuses a NativeMinter admin who could add a minter later", () => {
    const genesis = fuji();
    genesis.config.contractNativeMinterConfig.adminAddresses = [OPERATOR];
    assert.throws(() => check(genesis, REMOTE_DEPLOYER), /admin or manager/);
  });

  it("refuses a genesis built for another remote deployer", () => {
    assert.throws(() => check(fuji(), OPERATOR), /exactly the remote/);
  });

  it("refuses a base fee that would let old 49406 transactions replay", () => {
    const genesis = fuji();
    genesis.config.feeConfig.minBaseFee = Number(REPLAY_FLOOR_WEI) - 1;
    assert.throws(() => check(genesis, REMOTE_DEPLOYER), /replay floor/);
  });

  it("refuses fees that do not go to the validators who produce the blocks", () => {
    const burned = fuji();
    delete burned.config.rewardManagerConfig;
    assert.throws(() => check(burned, REMOTE_DEPLOYER), /go to the validators/);

    const fixed = fuji();
    fixed.config.rewardManagerConfig.initialRewardConfig = { allowFeeRecipients: false, rewardAddress: OPERATOR };
    assert.throws(() => check(fixed, REMOTE_DEPLOYER), /go to the validators/);
  });

  it("refuses Warp that trusts this chain's validators for C-Chain messages", () => {
    const genesis = fuji();
    genesis.config.warpConfig.requirePrimaryNetworkSigners = false;
    assert.throws(() => check(genesis, REMOTE_DEPLOYER), /Primary Network signers/);
  });

  it("refuses Warp that activates before Durango, which Subnet-EVM will not start", () => {
    const genesis = fuji();
    assert.equal(genesis.config.warpConfig.blockTimestamp, 1_790_000_000);
    genesis.config.warpConfig.blockTimestamp = 0;
    assert.throws(() => check(genesis, REMOTE_DEPLOYER), /Durango/);
  });

  it("refuses a block gas limit a full-kit launch does not fit in", () => {
    const genesis = fuji();
    genesis.config.feeConfig.gasLimit = 8_000_000;
    genesis.gasLimit = "0x7a1200";
    assert.throws(() => check(genesis, REMOTE_DEPLOYER), /full-kit launch/);
  });

  it("refuses a genesis without Teleporter", () => {
    const genesis = fuji();
    delete genesis.alloc["253b2784c75e510dd0ff1da844684a1ac0aa5fcf"];
    assert.throws(() => check(genesis, REMOTE_DEPLOYER), /TeleporterMessenger is missing/);
  });
});
