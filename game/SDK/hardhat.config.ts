import "dotenv/config";

import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

const cyberiaPrivateKey = process.env.CYBERIA_PRIVATE_KEY;

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          evmVersion: "paris",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
    },
    cyberia: {
      type: "http",
      chainType: "l1",
      chainId: 49406,
      url: process.env.CYBERIA_RPC_URL ?? "https://rpc.cyberia.church",
      accounts: cyberiaPrivateKey === undefined ? [] : [cyberiaPrivateKey],
    },
  },
});
