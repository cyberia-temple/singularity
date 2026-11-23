import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, parseEther, toHex } from "viem";

import { baseFeeForTransfer, build, check, predictRemote } from "../scripts/genesis.ts";
import { predictSafe, safeSalt } from "../scripts/lib/safe.ts";
import { cb58Decode } from "../scripts/validator-manager.ts";

const REMOTE_DEPLOYER = getAddress("0x2772608422d4De3C2F4fCEa038e879f4D39877A1");
const OPERATOR = getAddress("0xae8F9c21b082d09857622824ADA365D71b18B44B");

function fuji() {
  return build({
    network: "fuji",
    remoteDeployer: REMOTE_DEPLOYER,
    operator: OPERATOR,
    feeAdmin: OPERATOR,
    remoteGas: parseEther("100"),
    operatorGas: parseEther("10000"),
    timestamp: 1_790_000_000,
  });
}

describe("genesis", () => {
  it("lets only the remote's proxy mint and counts every genesis coin as owed collateral", () => {
    const genesis = fuji();
    assert.deepEqual(genesis.config.contractNativeMinterConfig.enabledAddresses, [predictRemote(REMOTE_DEPLOYER)]);
    assert.equal(check(genesis, { remoteDeployer: REMOTE_DEPLOYER }), parseEther("10100"));
  });

  it("refuses a minter other than the remote", () => {
    const genesis = fuji();
    genesis.config.contractNativeMinterConfig.enabledAddresses.push(OPERATOR);
    assert.throws(() => check(genesis, { remoteDeployer: REMOTE_DEPLOYER }), /exactly the remote/);
  });

  it("refuses a NativeMinter admin who could add a minter later", () => {
    const genesis = fuji();
    genesis.config.contractNativeMinterConfig.adminAddresses = [OPERATOR];
    assert.throws(() => check(genesis, { remoteDeployer: REMOTE_DEPLOYER }), /admin or manager/);
  });

  it("refuses a genesis built for another remote deployer", () => {
    assert.throws(() => check(fuji(), { remoteDeployer: OPERATOR }), /exactly the remote/);
  });

  it("refuses fees that do not go to the validators who produce the blocks", () => {
    const burned = fuji();
    delete burned.config.rewardManagerConfig;
    assert.throws(() => check(burned, { remoteDeployer: REMOTE_DEPLOYER }), /go to the validators/);

    const fixed = fuji();
    fixed.config.rewardManagerConfig.initialRewardConfig = { allowFeeRecipients: false, rewardAddress: OPERATOR };
    assert.throws(() => check(fixed, { remoteDeployer: REMOTE_DEPLOYER }), /go to the validators/);
  });

  it("refuses Warp that trusts this chain's validators for C-Chain messages", () => {
    const genesis = fuji();
    genesis.config.warpConfig.requirePrimaryNetworkSigners = false;
    assert.throws(() => check(genesis, { remoteDeployer: REMOTE_DEPLOYER }), /Primary Network signers/);
  });

  it("refuses Warp that activates before Durango, which Subnet-EVM will not start", () => {
    const genesis = fuji();
    assert.equal(genesis.config.warpConfig.blockTimestamp, 1_790_000_000);
    genesis.config.warpConfig.blockTimestamp = 0;
    assert.throws(() => check(genesis, { remoteDeployer: REMOTE_DEPLOYER }), /Durango/);
  });

  it("refuses a block gas limit a full-kit launch does not fit in", () => {
    const genesis = fuji();
    genesis.config.feeConfig.gasLimit = 8_000_000;
    genesis.gasLimit = "0x7a1200";
    assert.throws(() => check(genesis, { remoteDeployer: REMOTE_DEPLOYER }), /full-kit launch/);
  });

  it("refuses a genesis without Teleporter", () => {
    const genesis = fuji();
    delete genesis.alloc["253b2784c75e510dd0ff1da844684a1ac0aa5fcf"];
    assert.throws(() => check(genesis, { remoteDeployer: REMOTE_DEPLOYER }), /TeleporterMessenger is missing/);
  });
});

const SUPPLY = parseEther("1000000");
const DAO_SAFE = getAddress("0x96cd117786EBC0fDbef56a6559FEB2bd2BaE3393");

function mainnet() {
  return build({
    network: "mainnet",
    operator: OPERATOR,
    feeAdmin: OPERATOR,
    operatorGas: parseEther("1000"),
    fixed: { supply: SUPPLY, safe: DAO_SAFE },
    minBaseFee: baseFeeForTransfer("10"),
    timestamp: 1_800_000_000,
  });
}

describe("genesis with a fixed supply", () => {
  it("creates the whole supply at genesis, the operator's gas and the rest to the Safe, with no minter", () => {
    const genesis = mainnet();
    assert.equal(genesis.config.chainId, 49406);
    assert.equal(genesis.config.contractNativeMinterConfig, undefined);
    assert.equal(BigInt(genesis.alloc[OPERATOR.slice(2).toLowerCase()].balance), parseEther("1000"));
    assert.equal(BigInt(genesis.alloc[DAO_SAFE.slice(2).toLowerCase()].balance), parseEther("999000"));
    assert.equal(check(genesis, { fixedSupply: SUPPLY }), SUPPLY);
  });

  it("refuses a NativeMinter, whoever it enables", () => {
    const genesis = mainnet();
    genesis.config.contractNativeMinterConfig = { blockTimestamp: 0, enabledAddresses: [OPERATOR] };
    assert.throws(() => check(genesis, { fixedSupply: SUPPLY }), /no way to mint/);
  });

  it("refuses a genesis holding more or less than the supply", () => {
    assert.throws(() => check(mainnet(), { fixedSupply: parseEther("999999") }), /not the fixed supply/);
  });

  it("prices a plain transfer at ten CYBER", () => {
    const fee = BigInt(mainnet().config.feeConfig.minBaseFee) * 21_000n;
    assert.ok(fee >= parseEther("10") && fee < parseEther("10") + 21_000n);
  });
});

describe("the Safe's address before it exists", () => {
  it("is where validator-manager.ts created the Fuji Safe", () => {
    const owners = [
      "0xae8F9c21b082d09857622824ADA365D71b18B44B",
      "0x59a7b70675dE2566F0518738137e915B42cE8D61",
      "0x1eacbf0Ea21FFE36397a8e4A8bbe1d84cf919BEb",
    ].map((a) => getAddress(a.toLowerCase()));
    const subnetID = toHex(cb58Decode("UVRXcqMkQM9X8Wv6BmXXEbFbAcbKoW1t8vde5Lds35SLQSVn3"));
    assert.equal(predictSafe(owners, 2n, safeSalt(subnetID)), DAO_SAFE);
  });
});
