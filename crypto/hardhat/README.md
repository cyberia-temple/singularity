# Sample Hardhat 3 Beta Project (`node:test` and `viem`)

This project showcases a Hardhat 3 Beta project using the native Node.js test runner (`node:test`) and the `viem` library for Ethereum interactions.

To learn more about the Hardhat 3 Beta, please visit the [Getting Started guide](https://hardhat.org/docs/getting-started#getting-started-with-hardhat-3). To share your feedback, join our [Hardhat 3 Beta](https://hardhat.org/hardhat3-beta-telegram-group) Telegram group or [open an issue](https://github.com/NomicFoundation/hardhat/issues/new) in our GitHub issue tracker.

## Project Overview

This example project includes:

- A simple Hardhat configuration file.
- Foundry-compatible Solidity unit tests.
- TypeScript integration tests using [`node:test`](nodejs.org/api/test.html), the new Node.js native test runner, and [`viem`](https://viem.sh/).
- Examples demonstrating how to connect to different types of networks, including locally simulating OP mainnet.

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

You can also selectively run the Solidity or `node:test` tests:

```shell
npx hardhat test solidity
npx hardhat test nodejs
```

### Make a deployment to Sepolia

This project includes an example Ignition module to deploy the contract. You can deploy this module to a locally simulated chain or to Sepolia.

To run the deployment to a local chain:

```shell
npx hardhat ignition deploy ignition/modules/Counter.ts
```

To run the deployment to Sepolia, you need an account with funds to send the transaction. The provided Hardhat configuration includes a Configuration Variable called `SEPOLIA_PRIVATE_KEY`, which you can use to set the private key of the account you want to use.

You can set the `SEPOLIA_PRIVATE_KEY` variable using the `hardhat-keystore` plugin or by setting it as an environment variable.

To set the `SEPOLIA_PRIVATE_KEY` config variable using `hardhat-keystore`:

```shell
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
```

After setting the variable, you can run the deployment with the Sepolia network:

```shell
npx hardhat ignition deploy --network sepolia ignition/modules/Counter.ts
```

## Deploying USDC / USDT to Cyberia

`contracts/USDC.sol` and `contracts/USDT.sol` are 6-decimal ERC20s with
`mint` / `burnFrom` gated by `Ownable`. They mirror canonical USDC / USDT and
are meant to be driven by the Cyberia bridge / relayer (the owner). Both also
include `ERC20Permit` so wallets and the DEX can use gasless approvals.

### 1. Prerequisites

- `crypto/hardhat/.env` must contain the deployer key:

  ```env
  DEPLOYER_PK=0x...        # deployer private key (NEVER commit, NEVER paste in chat)
  # Optional overrides:
  # CYBERIA_RPC_URL=https://rpc.cyberia.church
  # USDC_OWNER=0x...       # final USDC owner / minter; defaults to deployer
  # USDT_OWNER=0x...       # final USDT owner / minter; defaults to deployer
  ```

  Do not echo, `cat`, or otherwise print `.env` contents — especially
  `DEPLOYER_PK`.

- Deployer address must hold enough CYBER on chain id `49406` to pay gas.

### 2. Install & compile

```shell
cd crypto/hardhat
npm install
npx hardhat compile
```

This produces `artifacts/contracts/USDC.sol/USDC.json` and
`artifacts/contracts/USDT.sol/USDT.json`, which the deploy scripts read.

### 3. Deploy to Cyberia

USDC:

```shell
cd crypto/hardhat
npx hardhat run scripts/deploy-usdc.ts --network cyberia
```

USDT:

```shell
cd crypto/hardhat
npx hardhat run scripts/deploy-usdt.ts --network cyberia
```

Each script will:

1. Load `DEPLOYER_PK` from `.env`.
2. Connect to Cyberia RPC (`CYBERIA_RPC_URL` or `https://rpc.cyberia.church`,
   chain id `49406`).
3. Deploy the token with constructor arg `initialOwner = USDC_OWNER` /
   `USDT_OWNER` (or the deployer if unset).
4. Print the deployed address, block number, and gas used.

Expected output (USDC, USDT is analogous):

```
Deploying USDC...
  Deployer: 0x....
  Initial owner / minter: 0x....
  RPC: https://rpc.cyberia.church
Transaction hash: 0x....
USDC deployed at: 0x....
Block: ...
Gas used: ...
```

### 4. After deployment

- Verify the contracts on Blockscout: <https://explorer.cyberia.church>
  (Solidity `0.8.19`, optimizer settings as in `hardhat.config.ts` `production`
  profile if you redeploy with `--profile production`).
- Save the deployed addresses (e.g. in `deployments/` or the Ritual DEX
  config).
- The owner (`USDC_OWNER` / `USDT_OWNER`) can now call `mint(to, amount)` to
  credit bridged stablecoins, and `burnFrom(from, amount)` to redeem them.

### 5. Minting USDC / USDT

Use `scripts/mint-stable.ts`. It works for both tokens; you just point it at
the right deployed address and tell it which token via `TOKEN`.

Required env vars (can be exported inline; `.env` is loaded but inline `KEY=…`
on the command line wins):

| Var            | Meaning                                     |
| -------------- | ------------------------------------------- |
| `DEPLOYER_PK`  | Owner / minter private key (from `.env`)    |
| `TOKEN`        | `USDC` or `USDT`                            |
| `TOKEN_ADDRESS`| Deployed token address on Cyberia           |
| `MINT_TO`      | Recipient address                           |
| `MINT_AMOUNT`  | Human amount, e.g. `1000` (= 1000 USDC/USDT)|

The script reads `decimals()` on-chain (`6` for both), converts the human
amount via `parseUnits`, and refuses to send if the caller is not the token
owner.

Mint 1,000 USDC:

```shell
cd crypto/hardhat
TOKEN=USDC \
TOKEN_ADDRESS=0xUsdcAddressOnCyberia \
MINT_TO=0xRecipient \
MINT_AMOUNT=1000 \
npx hardhat run scripts/mint-stable.ts --network cyberia
```

Mint 1,000 USDT:

```shell
cd crypto/hardhat
TOKEN=USDT \
TOKEN_ADDRESS=0xUsdtAddressOnCyberia \
MINT_TO=0xRecipient \
MINT_AMOUNT=1000 \
npx hardhat run scripts/mint-stable.ts --network cyberia
```

Expected output:

```
Token: USDC @ 0x....
Decimals: 6
Caller: 0x....
Token owner: 0x....
Mint to: 0x....
Amount: 1000 USDC (1000000000 base units)
Transaction hash: 0x....
Status: success
Gas used: ...
Recipient balance: 1000 USDC
```

> Do **not** put `DEPLOYER_PK` on the command line — keep it only in `.env`.
> Never paste `.env` contents or private keys into logs, chats, or commits.

### 6. Operational notes

- `decimals()` returns `6` to match canonical USDC / USDT. Always work in
  micro-units (`1 USDC = 1_000_000`, same for USDT).
- `mint` and the privileged `burnFrom` path require `msg.sender == owner()`.
- Non-owner users can still `burn(amount)` their own balance and
  `burnFrom(from, amount)` via standard ERC20 allowance.
- If you need to rotate the bridge owner, call `transferOwnership(newOwner)`
  from the current owner.

## DCA Buy Bot

`npm run dca:buy -- --once` runs a dry-run cycle. Add `--execute` only after the
dedicated DCA wallet is funded:

```shell
cd crypto/hardhat
DCA_PRIVATE_KEY=0x... npm run dca:buy -- --once --execute
```

The DCA bot intentionally ignores `DEPLOYER_PK` and refuses a `DCA_PRIVATE_KEY`
or `DCA_WALLET_KEYFILE` that equals `DEPLOYER_PK`. Use a separate key/address so
bridge/deployer funds cannot be spent by this process. Stablecoin targets
(`USDC`, `USDT`) are blocked by default because the script spends native CYBER;
set `allowStableTargets: true` in the config only when selling CYBER for stables
is intentional.

## Cyberia V3 (concentrated liquidity)

A PancakeSwap V3 fork, vendored and patched so that **a live pool's swap fee can be changed** without
asking its liquidity to migrate to another tier. On a chain with little liquidity, splitting what
exists across fee tiers is the one operation that cannot be afforded, so the fee became a setting.

That patch is what makes the second half possible: **a launch creator names their own fee** — any
number up to 10%, plus the protocol's 1% — where v3's tiers are a whitelist of four and would
otherwise offer them a choice of four. A launch pool is born in an 11% tier and lowered exactly once,
by the address that created it, before it has traded.

### Why PancakeSwap V3 and not Uniswap v4 or Algebra

Cyberia's EVM stops at **london** (`services/cyberia-node/genesis.json`; probed live, `PUSH0`,
`TSTORE` and `MCOPY` all answer *opcode not found*). Uniswap v4 needs EIP-1153 transient storage, so
it cannot run here without a hard fork of an archived client. Of what remains, PancakeSwap V3 is
`solc =0.7.6` (which structurally cannot emit `PUSH0`), GPL-2.0-or-later with no expiry, and ships
MasterChefV3 + LMPool, which is the answer to farming NFT positions. Algebra Integral is BUSL-1.1
until 2027-03-15.

### Layout

| Path | What it is |
|---|---|
| `contracts/pancake-v3-core/` | Vendored core. Only the mutable-fee patch diverges from upstream. |
| `contracts/pancake-v3-periphery/` | Vendored periphery: router, position manager, quoter, lens. |
| `contracts/pancake-v3-lm-pool/` | Vendored LM pool, for MasterChefV3 farming. |
| `contracts/cyberia-v3/` | What sits on top of the fork: locker, launchpad, launch token, splitter. |
| `scripts/deploy-v3.ts` | Deploys the stack, writes `deployments/cyberia-v3.json`. |
| `scripts/v3-smoke.ts` | Creates a pool, swaps, moves the fee, swaps again — on chain. |
| `scripts/v3-launch-smoke.ts` | Launches a token and collects its fees — on chain, or as a dry run. |
| `test/PancakeV3MutableFee.ts` | The guard rails for the fork's patch. |
| `test/PancakeV3CreatorFee.ts` | The creator's one-shot: who may use it, and how far down. |
| `test/LaunchpadV3.ts` `test/LaunchToken.ts` `test/LaunchLocker.ts` | The launch, the dividend, the lock. |

Sources are upstream byte-for-byte apart from import paths (`@pancakeswap/v3-core/contracts/…` →
relative) and the patch below. OpenZeppelin 3.4.2-solc-0.7 is installed under the aliases
`@openzeppelin/contracts-v3` / `@openzeppelin/contracts-upgradeable-v3` so it can sit beside the
4.9.5 the 0.8 contracts use.

### The patch

`fee` moves from `immutable` to storage; `PancakeV3Pool.setFee` accepts calls from the factory and
from nobody else; `PancakeV3Factory.setPoolFee` is `onlyOwner` and enforces `MAX_POOL_FEE` (11%).
Two further patches, both there so a launch creator can name their own fee:

- **`PancakeV3Factory.setPoolFeeByCreator`** — whoever called `createPool` may lower that pool's fee
  **once**, without being the factory owner. `createPool` records the caller in `poolCreator`, the
  adjustment deletes the entry, and it may only ever go **down** from the tier the pool was born in.
  A one-shot that only lowers is what makes an arbitrary fee safe to hand out: the right is spent
  before the pool has traded, it cannot be used twice, and no key gains a standing power over a pool
  it does not own;
- **`PancakeV3Pool.initialize` no longer sets a protocol fee.** Upstream starts every pool at
  `3200:3200` — 32% of all fees to `collectProtocol`. On a chain where the pitch is *the creator
  keeps their fee*, a silent 32% cut is the promise broken in the constructor, so a Cyberia pool
  starts at **0** and `setFeeProtocol` still turns it on per pool, with an event.

Everything else about the pool is untouched:

- **the pool's address does not change** — the fee in the CREATE2 salt stays the pool's identifier,
  so `PoolAddress`, the path encoding and any SDK that derives an address keep working;
- **`slot0()`'s ABI does not change** — `fee()` is still `view returns (uint24)`, it just reads
  storage now. It moved from `IPancakeV3PoolImmutables` to `IPancakeV3PoolState`, which is a
  documentation change: `IPancakeV3Pool` inherits both;
- **fees already earned do not move** — `feeGrowthGlobal` records what was charged, not the rate;
- **the swap loop does not read storage** — the fee is cached into `SwapCache` once per swap;
- **`tickSpacing` stays immutable.** Changing it would invalidate every tick already written.

`MAX_POOL_FEE` is **11%**, and that number is the product rule written into the contract: a launch
creator may take up to 10%, the protocol takes 1%, so 11% is the most a Cyberia pool can ever cost
to trade through. It is also what bounds a stolen owner key — without it a compromised owner could
set a pool to 100% and take the whole input of every swap that followed.

Read `pool.fee()` for what a pool charges. **Never** read the fee out of a pool key or a swap path:
that number is the pool's tier, and after a `setPoolFee` it is no longer what the pool charges.

### The size ceiling — read this before touching the pool

`PancakeV3PoolDeployer` carries the pool's entire creation code as a literal, so the **pool's** size
is spent against the **deployer's** 24576-byte EIP-170 limit. Upstream ships with roughly 19 bytes
to spare. After the mutable-fee patch there are **20** — dropping the protocol-fee default out of
`initialize` gave back more than the patch had cost:

```
PancakeV3PoolDeployer runtime 24556 bytes, 20 to spare
```

`test/PancakeV3MutableFee.ts` fails the moment that goes negative. The optimizer is not the lever
(`runs: 400 → 100` buys only ~200 bytes, at the cost of swap gas). If the pool needs to grow, give
the deployer an **external code holder** — a contract whose runtime code *is* the pool creation
code, `EXTCODECOPY`'d into memory before `CREATE2` — which buys about 1 KB and leaves the pool's
init code hash, and therefore every pool address, unchanged.

### After any change to the pool or its compiler settings

Recompute `POOL_INIT_CODE_HASH` in `contracts/pancake-v3-periphery/libraries/PoolAddress.sol`.
Every address the router, the quoter and the position manager derive comes from that constant; a
stale one makes all of them address contracts that are not there, silently. `scripts/deploy-v3.ts`
refuses to deploy when the constant and the compiled pool disagree.

```shell
npx hardhat compile
node -e 'const {keccak256}=require("ethers");console.log(keccak256(require("./artifacts/contracts/pancake-v3-core/PancakeV3Pool.sol/PancakeV3Pool.json").bytecode))'
```

### Deploying

```shell
npx hardhat compile
npx hardhat test nodejs                       # the whole suite, four of them are the v3 stack
npx tsx scripts/deploy-v3.ts                  # idempotent: re-running skips what is on chain
npx tsx scripts/v3-smoke.ts                   # optional: real pool, real swap, real fee change
SMOKE_DRY_RUN=1 npx tsx scripts/v3-launch-smoke.ts   # a launch as an eth_call, spending nothing
npx tsx scripts/v3-launch-smoke.ts            # a real launch: its CYBER is locked forever
```

**A recompiled pool is a new stack, not an upgrade.** Every address the periphery computes comes
from the pool's init code hash, so a router deployed against the old hash addresses pools the new
factory will never deploy. `deploy-v3.ts` refuses to mix the two: when the compiled hash differs
from the one in the record, it moves the record to `deployments/archive/` (the old contracts are
superseded, not gone — somebody's liquidity may still be in them) and deploys the whole stack again.

To rehearse a redeploy before spending anything, point `CYBERIA_RPC_URL` at a local node, set
`CYBERIA_CHAIN_ID` to its id and `V3_WCYBER` to a wrapper deployed there; the record then lands in
`deployments/cyberia-v3-<id>.json` and cannot overwrite what is on Cyberia.

`eth_estimateGas` is unreliable on this node — it fails on deploys and answers 21000 for a value
transfer to a contract — so every transaction in these scripts carries an explicit gas limit. Note
that **creating a pool costs about 4.9M gas**, because it deploys a 23 KB contract by CREATE2, and
a **launch costs about 7.9M**, because it deploys a token and a pool and mints a position in one
transaction. Cyberia's block limit is 30M, so that fits with room; EDR's per-transaction cap in the
tests is 2^24, which is why `test/LaunchpadV3.ts` passes an explicit `gas` of its own.

### Measured on Cyberia

| Operation | Gas |
|---|---|
| Deploy the whole stack (10 contracts) | 26.4M, 0.0398 CYBER |
| `createAndInitializePoolIfNecessary` | 4,839,553 |
| `mint` (full-range position) | 606,636 |
| `exactInputSingle` | 119,883 – 140,850 |
| `setPoolFee` | 36,704 |
| `enableFeeAmount` (the 11% tier) | 68,665 |
| `LaunchpadV3.launch` | 7.93M (bench) |

The launch figure is from a rehearsal chain running the same bytecode — the number a real launch
prints goes here once one has been made.

Runtime sizes, against EIP-170's 24576:

| Contract | Bytes |
|---|---|
| `PancakeV3PoolDeployer` | 24,556 (20 to spare — see the size ceiling above) |
| `LaunchpadV3` | 22,649 |
| `LaunchToken` | 9,953 |
| `LaunchLocker` | 9,744 |
| `PancakeV3Factory` | 7,020 |

### Fees: who sets them, and who is paid

Four contracts sit on top of the fork, in `contracts/cyberia-v3/`.

**`LaunchLocker`** — the answer to a launchpad creator earning nothing. A v2 launch burns its LP
token and the fees that LP would have earned go with it, because in v2 fees compound into reserves a
burned LP can no longer redeem. In v3 fees accrue *outside* the position, so a position can be
locked forever and still pay. This contract takes a position NFT and never lets it out — there is no
`decreaseLiquidity`, no `burn`, no transfer, and the test suite asserts the ABI has none of them —
while `collect` is open to anyone and splits what it collects between the launch's creator and the
treasury.

The split is **snapshotted when the position arrives**. `setDefaultCreatorBps` retunes what future
launches get, as often as you like; an existing launch keeps what it was accepted under. That
asymmetry is deliberate: a creator fee the operator can revoke is not a reason to launch here, and
the whole value of the offer is that the contract, not a promise, is what holds it. `setCreator` is
the creator's own, so a project that changes hands does not need us.

A position arrives with terms in one of two shapes, and anything else is refused rather than
defaulted — a position locked to nobody would pay its whole stream to the treasury forever with no
way back, since the NFT can never leave. 32 bytes name a creator and take the default split; 128
bytes name creator, creator bps, holders bps and a rewards address, and are accepted **only from an
allowlisted launcher** (`setLauncher`), because those numbers name the treasury's own share.

**`LaunchpadV3`** — a fair launch where the creator names the fee. `launch()` takes a name, a
symbol, a supply, a creator fee up to **10%** and how much of that fee to share with holders, then
in one transaction deploys the token, wraps the CYBER sent, creates the pool **in the 11% tier**,
lowers its fee to `creatorFee + 1%` with the factory's one-shot, mints one full-range position with
the entire supply against the entire CYBER, and hands that position to the locker with the split
written in. Nothing is upgradeable and nothing can take the liquidity back out.

The arithmetic is `quote(creatorFee, holdersShareBps)`, and a screen should print its answer rather
than restate it: the creator's side of the collected stream is `creatorFee / poolFee`, the holders'
share comes out of **that**, and the remainder is the protocol's — so at the maximum, a trade costs
11%, the treasury takes 910 bps of what is collected, and 910 bps of 11% is exactly the 1% of volume
the protocol charges. Rounding falls on the treasury, never on the creator or the holders. Sharing
with holders costs the protocol nothing, because it comes out of the creator's own half.

**`LaunchToken`** — holder fee sharing, which is the reason a token launched here is not a plain
ERC20. Trading fees arrive as WCYBER and are credited to every holder pro rata by magnified
per-share accounting (`MAGNITUDE = 2**128`, a correction per transfer, an `eligibleSupply` that
excludes the pool, the launchpad and the burn address — a pool paying itself a dividend would be
paying nobody). Holders `claim()` when they like; nothing is pushed, so a transfer costs the same as
any ERC20's. Two rules make the pot safe: a distribution books the **whole** amount received even
when the per-share figure floors, and a claim pays at most the balance actually held — the version
without the first one reverted on the last claimant for a rounding wei, which is what the test suite
caught. When the fee to be shared is the token itself rather than CYBER, the locker **burns** it,
which is the same pro-rata gift to every holder and needs no accounting at all.

**`FeeSplitter`** — where `collectProtocol` proceeds go. A weighted recipient set the owner can
replace at any time, `distribute` open to anyone so no recipient depends on an operator remembering,
the rounding remainder given to the last recipient so nothing is stranded, and
`unwrapAndDistributeNative` for the one recipient that must be paid in the coin — the gas station's
tank. A recipient that cannot accept a plain transfer is credited to `owedNative` rather than
reverting the whole payout. It does not swap and does not price anything: a buy-back-and-burn is a
*recipient*, not a feature of this contract.

Existing v2 launches (LAIN, MINE) can never be retrofitted — their LP is already burned.

### What is deployed on Cyberia

Redeployed **2026-09-07**: the fee ceiling, the creator's one-shot and the protocol-fee default are
all in the pool and the factory, so the previous stack could not be upgraded into this one. Its
record is kept under `deployments/archive/` — those contracts are superseded, not gone, and the old
factory `0x79F4C9f4E1dbA86F173c06D2491eB31123f38637` still owns whatever was in it.

| Contract | Address |
|---|---|
| `PancakeV3PoolDeployer` | `0x216Caa611CE6F300c6b23f1D00Aa6055F77dE773` |
| `PancakeV3Factory` | `0xB6abF60A04fC1ac64Bf225787B7064A94165b496` |
| `SwapRouter` | `0xa9f2A35F8dbA643e199Da0FeEbDF7e1c72ee773e` |
| `NonfungiblePositionManager` | `0x50A0B7Fd739fE3afC27fF5c8259Ae1c76B569139` |
| `NonfungibleTokenPositionDescriptor` | `0xb7beA09BB3C23a2fA5BBa50EE8F648F6148E4C6d` |
| `QuoterV2` | `0xD583dDAf0f9B1bb227832f9c4948519C697DCF99` |
| `TickLens` | `0x7984b22c5726fC623FFA49AaC94a18AFFf96fa47` |
| `LaunchLocker` | `0x679958816454079ef2b31d5ED8DD243ffa9D7689` |
| `LaunchpadV3` | `0x6970481a167D8D44527091d0E319e50aD3F79Ee3` |
| `FeeSplitter` | `0x361b763a718a361C17FE39d4bc1d2EbE05572da6` |

Live settings: creator share **70%** for a plain lock, `MAX_POOL_FEE` **11%**, the launch tier
**110000 / tick spacing 200**, launch minimum **10 CYBER**, splitter paying **100% to the gas
station tank**, and a **protocol fee of 0** on the pools themselves — the protocol's 1% of a launch
comes out of the launch position's own fee stream, not out of `collectProtocol`, which is why no
pool needs `setFeeProtocol` turned on for the launchpad's promise to hold. Taking a share of LP fees
while there is barely any liquidity would repel the liquidity the chain is trying to attract; the
dial is built so it can be turned up when there is a reason to, not because there is one now.

Everything above is owned by a single address (`factory.owner`, `locker.owner`, `splitter.owner`).
Handing it to a timelock or a governor later is one `setOwner` per contract, with no redeploy and no
liquidity migration. Every setting emits an event, which is what makes that handover credible: the
record of how the dials were used will exist, and it cannot be created after the fact.
