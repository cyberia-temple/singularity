import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

/**
 * Interactive CLI for managing the OZ-style mintable/burnable ERC20s
 * registered in `deployments/cyberia-tokens.json`.
 *
 * Run:    node scripts/token-admin.ts (from crypto/hardhat)
 * Env:    DEPLOYER_PK (required, owner of the token), CYBERIA_RPC_URL (optional)
 */

type TokenEntry = {
  symbol: string;
  contract: string;
  artifact: string;
  address: string | null;
  burnable: boolean;
};

type Registry = {
  chainId: number;
  rpc: string;
  tokens: TokenEntry[];
};

const REGISTRY_PATH = path.resolve("deployments/cyberia-tokens.json");
const MANAGED_ASSET_ARTIFACT = "contracts/ManagedAsset.sol/ManagedAsset.json";

function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(`Token registry not found at ${REGISTRY_PATH}`);
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as Registry;
}

function loadArtifact(artifactRelPath: string) {
  const full = path.resolve("artifacts", artifactRelPath);
  if (!fs.existsSync(full)) {
    throw new Error(
      `Artifact not found at ${full}. Run "npx hardhat compile" first.`,
    );
  }
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK is not set in .env");
const pk = (DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`) as `0x${string}`;
const account = privateKeyToAccount(pk);

const registry = loadRegistry();
const RPC_URL = process.env.CYBERIA_RPC_URL ?? registry.rpc ?? "https://rpc.cyberia.church";

const cyberia = {
  ...mainnet,
  id: registry.chainId ?? 49406,
  name: "Cyberia",
  nativeCurrency: { name: "CYBER", symbol: "CYBER", decimals: 18 },
};

const publicClient = createPublicClient({ chain: cyberia, transport: http(RPC_URL) });
const walletClient = createWalletClient({ chain: cyberia, transport: http(RPC_URL), account });

const rl = readline.createInterface({ input, output });

async function ask(question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function pickFromList<T>(items: T[], render: (item: T, i: number) => string): Promise<T> {
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}) ${render(items[i], i)}`);
  }
  while (true) {
    const raw = await ask(`Pick [1-${items.length}]: `);
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    console.log("  invalid selection");
  }
}

async function createManagedAsset() {
  console.log("\nCreate an operator-managed asset token (no initial supply).");
  console.log("This does NOT tokenize or custody the underlying shares.");

  const name = await ask("Token name (e.g. Sberbank Shares): ");
  const symbol = await ask("Symbol (e.g. SBER): ");
  const decimalsInput = await ask("Decimals [18] (0-18): ");
  const ownerInput = await ask(`Owner/minter address [${account.address}]: `);
  const owner = ownerInput || account.address;
  const decimals = decimalsInput === "" ? 18 : Number(decimalsInput);

  if (!name || name.length > 100 || !symbol || !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) {
    console.log("Invalid name or symbol (symbol: 1-32 letters/digits/._-). Nothing deployed.");
    return;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    console.log("Decimals must be an integer from 0 to 18. Nothing deployed.");
    return;
  }
  if (!isAddress(owner)) {
    console.log("Invalid owner address. Nothing deployed.");
    return;
  }
  if (loadRegistry().tokens.some((token) => token.symbol.toLowerCase() === symbol.toLowerCase())) {
    console.log(`Symbol ${symbol} already exists in the registry. Nothing deployed.`);
    return;
  }

  const networkId = await publicClient.getChainId();
  if (networkId !== registry.chainId) {
    throw new Error(`Wrong network: RPC returned ${networkId}, registry expects ${registry.chainId}`);
  }
  const artifact = loadArtifact(MANAGED_ASSET_ARTIFACT);

  console.log(`\nNetwork: ${networkId} (${RPC_URL})`);
  console.log(`Token:   ${name} (${symbol}), ${decimals} decimals`);
  console.log(`Owner:   ${owner}`);
  console.log("Supply:  0 (use the mint action after deployment)");
  console.log("WARNING: the owner may mint and burn tokens from any address.");
  const confirm = await ask('Type DEPLOY to send a mainnet transaction: ');
  if (confirm !== "DEPLOY") {
    console.log("Cancelled.");
    return;
  }

  // Cyberia's eth_estimateGas is unreliable for contract creation.
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args: [name, symbol, decimals, owner],
    gas: 5_000_000n,
  });
  console.log("Deployment tx:", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Deployment failed (tx ${hash})`);
  }
  const address = receipt.contractAddress;
  console.log("Deployed address:", address);

  // Use the chain as source of truth before adding this token to the local CLI.
  const [onchainName, onchainSymbol, onchainDecimals, onchainOwner] = await Promise.all([
    publicClient.readContract({ address, abi: artifact.abi, functionName: "name" }) as Promise<string>,
    publicClient.readContract({ address, abi: artifact.abi, functionName: "symbol" }) as Promise<string>,
    publicClient.readContract({ address, abi: artifact.abi, functionName: "decimals" }) as Promise<number>,
    publicClient.readContract({ address, abi: artifact.abi, functionName: "owner" }) as Promise<Address>,
  ]);
  if (onchainName !== name || onchainSymbol !== symbol || Number(onchainDecimals) !== decimals || onchainOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Deployed token metadata mismatch at ${address}; register it manually after checking`);
  }

  const freshRegistry = loadRegistry();
  if (freshRegistry.tokens.some((token) => token.symbol.toLowerCase() === symbol.toLowerCase())) {
    throw new Error(`Symbol was added while deploying. Token ${address} exists but was not registered.`);
  }
  freshRegistry.tokens.push({
    symbol,
    contract: "ManagedAsset",
    artifact: MANAGED_ASSET_ARTIFACT,
    address,
    burnable: true,
  });
  const temporaryPath = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(freshRegistry, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporaryPath, REGISTRY_PATH);
  registry.tokens = freshRegistry.tokens;
  console.log(`Saved to ${REGISTRY_PATH}. Choose ${symbol} in the menu to mint shares.`);
}

async function readMeta(token: TokenEntry, abi: unknown) {
  const address = token.address as Address;
  const [name, symbol, decimals, owner, totalSupply] = await Promise.all([
    publicClient.readContract({ address, abi: abi as never, functionName: "name" }) as Promise<string>,
    publicClient.readContract({ address, abi: abi as never, functionName: "symbol" }) as Promise<string>,
    publicClient.readContract({ address, abi: abi as never, functionName: "decimals" }) as Promise<number>,
    publicClient.readContract({ address, abi: abi as never, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address, abi: abi as never, functionName: "totalSupply" }) as Promise<bigint>,
  ]);
  return { name, symbol, decimals: Number(decimals), owner, totalSupply };
}

async function mint(token: TokenEntry, abi: unknown, decimals: number, symbol: string) {
  const to = await ask("Recipient address: ");
  if (!isAddress(to)) throw new Error(`Invalid address: ${to}`);
  const amountStr = await ask(`Amount (${symbol}, human-readable): `);
  const amount = parseUnits(amountStr, decimals);

  console.log(`\nMint ${amountStr} ${symbol} → ${to}`);
  const confirm = (await ask("Proceed? [y/N]: ")).toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    console.log("Cancelled.");
    return;
  }

  const { request } = await publicClient.simulateContract({
    address: token.address as Address,
    abi: abi as never,
    functionName: "mint",
    args: [to as Address, amount],
    account,
  });
  const hash = await walletClient.writeContract(request);
  console.log("  tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("  status:", receipt.status, "gas:", receipt.gasUsed.toString());

  const bal = (await publicClient.readContract({
    address: token.address as Address,
    abi: abi as never,
    functionName: "balanceOf",
    args: [to as Address],
  })) as bigint;
  console.log(`  ${to} balance: ${formatUnits(bal, decimals)} ${symbol}`);
}

async function burn(token: TokenEntry, abi: unknown, decimals: number, symbol: string) {
  if (!token.burnable) {
    console.log(`${symbol} has no burn function in its contract — skipping.`);
    return;
  }
  const from = await ask("Burn from address: ");
  if (!isAddress(from)) throw new Error(`Invalid address: ${from}`);
  const amountStr = await ask(`Amount (${symbol}, human-readable): `);
  const amount = parseUnits(amountStr, decimals);

  console.log(`\nBurn ${amountStr} ${symbol} from ${from}`);
  const confirm = (await ask("Proceed? [y/N]: ")).toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    console.log("Cancelled.");
    return;
  }

  // Our tokens override burnFrom so the owner can burn from any holder without
  // needing an allowance — the relayer / admin path.
  const { request } = await publicClient.simulateContract({
    address: token.address as Address,
    abi: abi as never,
    functionName: "burnFrom",
    args: [from as Address, amount],
    account,
  });
  const hash = await walletClient.writeContract(request);
  console.log("  tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("  status:", receipt.status, "gas:", receipt.gasUsed.toString());

  const bal = (await publicClient.readContract({
    address: token.address as Address,
    abi: abi as never,
    functionName: "balanceOf",
    args: [from as Address],
  })) as bigint;
  console.log(`  ${from} balance: ${formatUnits(bal, decimals)} ${symbol}`);
}

async function balanceOf(token: TokenEntry, abi: unknown, decimals: number, symbol: string) {
  const who = await ask("Address: ");
  if (!isAddress(who)) throw new Error(`Invalid address: ${who}`);
  const bal = (await publicClient.readContract({
    address: token.address as Address,
    abi: abi as never,
    functionName: "balanceOf",
    args: [who as Address],
  })) as bigint;
  console.log(`  ${who}: ${formatUnits(bal, decimals)} ${symbol}`);
}

async function main() {
  console.log("=== Cyberia token admin ===");
  console.log("RPC:    ", RPC_URL);
  console.log("Caller: ", account.address);
  console.log();

  // Outer loop: keep returning to the token picker so several tokens can be
  // managed in one session. The picker carries its own "quit" entry.
  while (true) {
    const deployed = registry.tokens.filter((t) => t.address);
    console.log("\nDeployed tokens:");
    type Choice = { kind: "token"; token: TokenEntry } | { kind: "create" } | { kind: "quit" };
    const choices: Choice[] = [
      ...deployed.map((token): Choice => ({ kind: "token", token })),
      { kind: "create" },
      { kind: "quit" },
    ];
    const picked = await pickFromList(choices, (c) =>
      c.kind === "quit" ? "quit" : c.kind === "create" ? "+ create new asset token" : `${c.token.symbol.padEnd(7)} ${c.token.address}`,
    );
    if (picked.kind === "quit") break;
    if (picked.kind === "create") {
      await createManagedAsset();
      continue;
    }
    const token = picked.token;

    const artifact = loadArtifact(token.artifact);
    const meta = await readMeta(token, artifact.abi);

    console.log(`\n${meta.name} (${meta.symbol})`);
    console.log(`  address:      ${token.address}`);
    console.log(`  decimals:     ${meta.decimals}`);
    console.log(`  owner:        ${meta.owner}`);
    console.log(`  totalSupply:  ${formatUnits(meta.totalSupply, meta.decimals)} ${meta.symbol}`);

    if (meta.owner.toLowerCase() !== account.address.toLowerCase()) {
      console.log(
        `\n  ! Caller is not the token owner. Mint and owner-burn will revert.`,
      );
    }

    // Inner loop: run several actions on the same token before going back to
    // the picker (or quitting the whole session).
    let backToPicker = false;
    while (!backToPicker) {
      console.log("\nAction:");
      const actions = [
        { key: "mint", label: "mint" },
        ...(token.burnable ? [{ key: "burn", label: "burn (owner-bypass burnFrom)" }] : []),
        { key: "balance", label: "check balance" },
        { key: "back", label: "← back to token list" },
        { key: "quit", label: "quit" },
      ];
      const action = await pickFromList(actions, (a) => a.label);

      switch (action.key) {
        case "mint":
          await mint(token, artifact.abi, meta.decimals, meta.symbol);
          break;
        case "burn":
          await burn(token, artifact.abi, meta.decimals, meta.symbol);
          break;
        case "balance":
          await balanceOf(token, artifact.abi, meta.decimals, meta.symbol);
          break;
        case "back":
          backToPicker = true;
          break;
        case "quit":
          rl.close();
          return;
      }
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
