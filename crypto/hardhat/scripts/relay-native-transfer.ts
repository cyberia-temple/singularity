/**
 * Native-coin bridge payout for any EVM chain (e.g. BNB on BSC when bridging
 * evm_to_bnb): plain value transfer from the relayer EOA to the recipient.
 *
 * Usage:
 *   npx tsx scripts/relay-native-transfer.ts <recipient> <amount_wei>
 *
 * env:
 *   BRIDGE_RELAYER_PRIVATE_KEY — relayer EOA (must hold the native balance)
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

async function main() {
  const [, , recipient, amountWei] = process.argv;

  if (!recipient || !amountWei) {
    console.error("Usage: relay-native-transfer.ts <recipient> <amount_wei>");
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
  console.log(`To:      ${recipient}`);
  console.log(`Amount:  ${amountWei} wei (chain ${CHAIN_ID})`);

  const { hash } = await broadcastWithRecovery(
    wallet,
    provider,
    {
      to: recipient,
      value: BigInt(amountWei),
    },
    {
      onSigned: (hash) => {
        console.log(JSON.stringify({ broadcastTxHash: hash }));
      },
    },
  );
  // The signed hash is emitted before broadcast so an uncertain RPC response
  // cannot make the caller pay a second time.
  const receipt = await waitForReceipt(provider, hash);

  if (!receipt) {
    // Broadcast but not confirmed within budget — exit non-zero so the caller
    // recovers the broadcastTxHash above and reconciles it on-chain instead of
    // retrying (which would double-pay).
    throw new Error(`Native transfer receipt not observed (tx ${hash})`);
  }
  if (receipt.status !== 1) {
    throw new Error(`Native transfer reverted (tx ${hash})`);
  }

  console.log(JSON.stringify({ txHash: receipt.hash }));
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
