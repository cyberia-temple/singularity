import "dotenv/config";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

const DEPLOYER_PK = process.env.DEPLOYER_PK;

if (!DEPLOYER_PK) {
  throw new Error("DEPLOYER_PK is not set in .env");
}

// PancakeSwap V3 is built with solc 0.7.6 targeting istanbul, metadata hash stripped.
// Cyberia's EVM stops at london, so istanbul is the safe floor: no PUSH0, no transient storage.
// The optimizer runs must match Pancake's per-file settings, otherwise the pool bytecode -- and
// therefore POOL_INIT_CODE_HASH, which the whole periphery derives pool addresses from -- changes.
const V3 = {
  version: "0.7.6",
  settings: {
    evmVersion: "istanbul",
    optimizer: { enabled: true, runs: 1_000_000 },
    metadata: { bytecodeHash: "none" },
  },
};

const V3_400 = {
  version: "0.7.6",
  settings: {
    evmVersion: "istanbul",
    optimizer: { enabled: true, runs: 400 },
    metadata: { bytecodeHash: "none" },
  },
};

const V3_2000 = {
  version: "0.7.6",
  settings: {
    evmVersion: "istanbul",
    optimizer: { enabled: true, runs: 2_000 },
    metadata: { bytecodeHash: "none" },
  },
};

const V3_1000 = {
  version: "0.7.6",
  settings: {
    evmVersion: "istanbul",
    optimizer: { enabled: true, runs: 1_000 },
    metadata: { bytecodeHash: "none" },
  },
};

// Most vendored v3 files carry a loose pragma (">=0.5.0", ">=0.7.0"), which Hardhat would
// happily satisfy with 0.8.19 -- and 0.8's checked arithmetic and stricter casts break code
// written for 0.7. Every file under the vendored trees is pinned to 0.7.6 explicitly.
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

const V3_TREES = [
  "contracts/pancake-v3-core",
  "contracts/pancake-v3-lm-pool",
  "contracts/pancake-v3-periphery",
];

const V3_OVERRIDES: Record<string, typeof V3> = Object.fromEntries(
  V3_TREES.flatMap((tree) => solFiles(tree)).map((file) => [file, V3]),
);

// Files upstream compiles with a lower optimizer setting, mostly to stay under the 24 KB
// contract size limit. The pool's setting is load-bearing beyond size: it decides the
// bytecode, and therefore POOL_INIT_CODE_HASH, which the whole periphery derives addresses from.
Object.assign(V3_OVERRIDES, {
  // core (upstream: 400 runs)
  "contracts/pancake-v3-core/PancakeV3Pool.sol": V3_400,
  "contracts/pancake-v3-core/PancakeV3PoolDeployer.sol": V3_400,
  // periphery (upstream: 2000 / 1000 runs)
  "contracts/pancake-v3-periphery/NonfungiblePositionManager.sol": V3_2000,
  "contracts/pancake-v3-periphery/NFTDescriptorEx.sol": V3_1000,
  "contracts/pancake-v3-periphery/NonfungibleTokenPositionDescriptor.sol": V3_1000,
  "contracts/pancake-v3-periphery/libraries/NFTDescriptor.sol": V3_1000,
});

const COMPILERS = [
  { version: "0.8.19", settings: { optimizer: { enabled: true, runs: 200 } } },
  V3,
  { version: "0.6.6", settings: { optimizer: { enabled: true, runs: 200 } } },
  { version: "0.5.16", settings: { optimizer: { enabled: true, runs: 200 } } },
];

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        compilers: COMPILERS,
        overrides: V3_OVERRIDES,
      },
      production: {
        compilers: COMPILERS,
        overrides: V3_OVERRIDES,
      },
    },
  },
  networks: {
    // Cyberia's own block gas limit, so a transaction that fits on the chain fits in the tests.
    // A v3 launch deploys a 23 KB pool and a token in one call and lands around 16M gas; EDR's
    // default cap is 2**24, which would refuse on the test bench something the chain accepts.
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      blockGasLimit: 30_000_000n,
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
      blockGasLimit: 30_000_000n,
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    cyberia: {
      type: "http",
      url: "https://rpc.cyberia.church",
      chainId: 49406,
      accounts: [DEPLOYER_PK],
    },
  },
});
