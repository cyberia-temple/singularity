/**
 * Direct-model bridge relayer for EVM destination.
 *
 * Called by Laravel after verifying that the user has deposited the source
 * token to the relayer hot wallet (on Solana for direction=sol_to_evm).
 *
 * Usage:
 *   npx tsx scripts/relay-erc20-transfer.ts <token_addr> <recipient> <amount_wei> [gas_drop_wei]
 *
 * env:
 *   BRIDGE_RELAYER_PRIVATE_KEY — relayer EOA (sends the tokens + optional gas)
 *   EVM_RPC_URL / EVM_CHAIN_ID — target EVM chain (default Cyberia via
 *   CYBERIA_RPC_URL / 49406)
 *
 * stdout (last line):
 *   {"txHash":"0x...","gasDropTxHash":"0x..."|null}
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

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
];

async function main() {
  const [, , tokenAddr, recipient, amountWei, gasDropWei] = process.argv;

  if (!tokenAddr || !recipient || !amountWei) {
    console.error(
      "Usage: relay-erc20-transfer.ts <token_addr> <recipient> <amount_wei> [gas_drop_wei]",
    );
    process.exit(1);
  }

  const pk = (
    RELAYER_PK!.startsWith("0x") ? RELAYER_PK! : `0x${RELAYER_PK}`
  ) as `0x${string}`;
  // staticNetwork avoids an extra eth_chainId roundtrip per call.
  const network = new ethers.Network(CHAIN_NAME, CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC_URL, network, {
    staticNetwork: network,
    polling: false,
  });
  const wallet = new ethers.Wallet(pk, provider);

  console.log(`Relayer: ${wallet.address}`);
  console.log(`Token:   ${tokenAddr}`);
  console.log(`To:      ${recipient}`);
  console.log(`Amount:  ${amountWei}`);

  const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const { hash } = await broadcastWithRecovery(
    wallet,
    provider,
    await token.transfer.populateTransaction(recipient, BigInt(amountWei)),
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
    throw new Error(`ERC20.transfer receipt not observed (tx ${hash})`);
  }
  if (receipt.status !== 1) {
    throw new Error(`ERC20.transfer reverted (tx ${hash})`);
  }

  let gasDropTxHash: string | null = null;

  if (gasDropWei && BigInt(gasDropWei) > 0n) {
    console.log(`GasDrop: ${gasDropWei} wei`);
    const { hash: dropHash } = await broadcastWithRecovery(wallet, provider, {
      to: recipient,
      value: BigInt(gasDropWei),
    });
    const dropReceipt = await waitForReceipt(provider, dropHash);

    if (!dropReceipt || dropReceipt.status !== 1) {
      throw new Error(`Gas drop transfer reverted (tx ${dropHash})`);
    }

    gasDropTxHash = dropHash;
  }

  console.log(JSON.stringify({ txHash: receipt.hash, gasDropTxHash }));
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
