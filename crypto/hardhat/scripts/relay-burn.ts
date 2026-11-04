/**
 * Mint-model bridge relayer — burn step for evm_to_sol bridges.
 *
 * After the user has transferred wrapped-USDC/USDT to the relayer EOA, the
 * relayer burns its received balance so the EVM-side supply stays in sync
 * with the Solana hot-wallet reserve. Uses burnFrom(owner, amount) which is
 * gated to the owner without requiring allowance.
 *
 * Usage:
 *   npx tsx scripts/relay-burn.ts <token_addr> <amount_wei>
 *
 * env:
 *   BRIDGE_RELAYER_PRIVATE_KEY — relayer EOA (must be owner of the token contract)
 *   EVM_RPC_URL / EVM_CHAIN_ID — target EVM chain (default Cyberia via
 *   CYBERIA_RPC_URL / 49406)
 *
 * stdout (last line):
 *   {"txHash":"0x..."}
 */
import "dotenv/config";
import { ethers } from "ethers";
import { waitForReceipt } from "./lib/wait-receipt";
import { broadcastWithRecovery } from "./lib/send-tx";

const RELAYER_PK =
  process.env.BRIDGE_RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PK;

if (!RELAYER_PK) {
  console.error("BRIDGE_RELAYER_PRIVATE_KEY or DEPLOYER_PK not set");
  process.exit(1);
}

// Generic EVM chain params (BSC etc.); legacy Cyberia vars as fallback.
const RPC_URL =
  process.env.EVM_RPC_URL ||
  process.env.CYBERIA_RPC_URL ||
  "https://rpc.cyberia.church";
const CHAIN_ID = Number(process.env.EVM_CHAIN_ID || 49406);
const CHAIN_NAME = process.env.EVM_NETWORK_NAME || "evm";

const BURNABLE_ABI = ["function burnFrom(address from, uint256 amount)"];

async function main() {
  const [, , tokenAddr, amountWei] = process.argv;

  if (!tokenAddr || !amountWei) {
    console.error("Usage: relay-burn.ts <token_addr> <amount_wei>");
    process.exit(1);
  }

  const pk = (
    RELAYER_PK!.startsWith("0x") ? RELAYER_PK! : `0x${RELAYER_PK}`
  ) as `0x${string}`;
  const network = new ethers.Network(CHAIN_NAME, CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC_URL, network, {
    staticNetwork: network,
    polling: false,
  });
  const wallet = new ethers.Wallet(pk, provider);

  console.log(`Relayer: ${wallet.address}`);
  console.log(`Token:   ${tokenAddr}`);
  console.log(`Burn:    ${amountWei} wei from relayer's own balance`);

  const token = new ethers.Contract(tokenAddr, BURNABLE_ABI, wallet);
  const { hash } = await broadcastWithRecovery(
    wallet,
    provider,
    await token.burnFrom.populateTransaction(wallet.address, BigInt(amountWei)),
    {
      onSigned: (hash) => {
        console.log(JSON.stringify({ broadcastTxHash: hash }));
      },
    },
  );
  const receipt = await waitForReceipt(provider, hash);

  if (!receipt) {
    throw new Error(`burnFrom() receipt not observed (tx ${hash})`);
  }
  if (receipt.status !== 1) {
    throw new Error(`burnFrom() reverted (tx ${hash})`);
  }

  console.log(JSON.stringify({ txHash: receipt.hash }));
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
