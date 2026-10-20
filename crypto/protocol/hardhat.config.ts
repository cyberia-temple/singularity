import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

// The protocol itself: 0.8.28 against Cancun, which subnet-evm has run since the Etna upgrade
// (transient storage and MCOPY yes, blobs no). Nothing here depends on blobs.
const PROTOCOL = {
  version: "0.8.28",
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
  },
};

// The vendored PancakeSwap V3 fork. Its optimizer settings are load-bearing: they decide the
// pool's bytecode and therefore POOL_INIT_CODE_HASH, which the periphery derives every pool
// address from. Keep them exactly as upstream compiles each file.
const V3 = {
  version: "0.7.6",
  settings: {
    evmVersion: "istanbul",
    optimizer: { enabled: true, runs: 1_000_000 },
    metadata: { bytecodeHash: "none" },
  },
};
const v3With = (runs: number) => ({ ...V3, settings: { ...V3.settings, optimizer: { enabled: true, runs } } });

const ROOT = dirname(fileURLToPath(import.meta.url));

function solFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...solFiles(rel));
    else if (entry.name.endsWith(".sol")) out.push(rel);
  }
  return out;
}

// Vendored files carry loose pragmas (">=0.5.0") that 0.8 would satisfy and then miscompile,
// so every one of them is pinned to 0.7.6 explicitly.
const OVERRIDES: Record<string, typeof V3> = Object.fromEntries(
  ["contracts/vendor/pancake-v3-core", "contracts/vendor/pancake-v3-lm-pool", "contracts/vendor/pancake-v3-periphery"]
    .flatMap((tree) => solFiles(tree))
    .map((file) => [file, V3]),
);

Object.assign(OVERRIDES, {
  "contracts/vendor/pancake-v3-core/PancakeV3Pool.sol": v3With(400),
  "contracts/vendor/pancake-v3-core/PancakeV3PoolDeployer.sol": v3With(400),
  "contracts/vendor/pancake-v3-periphery/NonfungiblePositionManager.sol": v3With(2_000),
  "contracts/vendor/pancake-v3-periphery/NonfungibleTokenPositionDescriptorOffChain.sol": v3With(1_000),
});

const COMPILERS = [PROTOCOL, V3];

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: { compilers: COMPILERS, overrides: OVERRIDES },
      production: { compilers: COMPILERS, overrides: OVERRIDES },
    },
  },
  paths: {
    tests: { solidity: "test" },
  },
  networks: {
    // A launch deploys a 23 KB pool, a token and their accounts in one call; the chain's own
    // block gas limit is what the test bench has to accept too.
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      blockGasLimit: 60_000_000n,
    },
    cyberia: {
      type: "http",
      chainType: "l1",
      url: configVariable("CYBERIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PK")],
    },
    fuji: {
      type: "http",
      chainType: "l1",
      url: configVariable("FUJI_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PK")],
    },
  },
});
