# Cyberia protocol

The contracts Cyberia relaunches with on its Avalanche L1. They replace `crypto/hardhat/contracts`
as a whole: the old chain is not migrated, so nothing here is constrained by what was deployed
there, and nothing there is changed by what is here.

The idea in one sentence: **launching a token opens its whole economy** — a market, liquidity anyone
can add, credit in both directions, a farm, a name zone and a DAO — and every way of earning on
Cyberia plugs into that economy.

## Layout

| Path | What it is |
| --- | --- |
| `contracts/access` | `CyberiaAuthority` (OpenZeppelin AccessManager) and `Roles` — one authority for every contract |
| `contracts/tokens` | `WCYBER`, `Ash` (capped, minted only by the Minter), `LaunchToken` (clone per launch) |
| `contracts/launch` | `Launchpad` (launch + kit + registry of every token's economy), `LaunchLocker` |
| `contracts/liquidity` | `LiquidityVault` (full-range V3 liquidity as an ERC-20) and its factory |
| `contracts/lending` | `Lending` (isolated markets, Morpho Blue model), `AdaptiveCurveIrm`, `CreditVault` (ERC-4626 over markets), `LendingViews` |
| `contracts/oracles` | `V3TwapOracle`, `LiquidityVaultOracle`, `ChainedOracle`, `OracleFactory` |
| `contracts/incentives` | `VotingEscrow` (veASH), `Voter`, `Gauge`, `Minter` (ASH from fire), `BuildersFund`, `PioneerDrop` |
| `contracts/treasury` | `RevenueRouter` — where every protocol fee arrives and where it goes; `Furnace` — where CYBER burns |
| `contracts/bridge` | `BridgeGateway` and one `BridgedToken` implementation for every bridged asset |
| `contracts/identity` | `Domains` (the one naming system), `Badges` (soulbound achievements) |
| `contracts/governance` | `DAOFactory`, `TokenGovernor`, `VotesWrapper` |
| `contracts/predict` | `PredictionMarket` — any currency, 2–8 outcomes, optimistic resolution |
| `contracts/nft` | `CyberiaNFT` (open collection with royalties), `NFTMarket` |
| `contracts/community` | `CommunityToken` (mintable reward token with votes) and its factory |
| `contracts/apps` | `GasStation`, `PixelBattle`, `WiredForge`, `MinecraftLand` |
| `contracts/vendor` | PancakeSwap V3 core + periphery (two factory changes, below), Multicall3 |
| `scripts/deploy.ts` | Resumable deployment of everything, roles included |
| `scripts/genesis.ts` | CYBER's genesis: the fixed supply, the bridge backing at the gateway's address, the predeploys; refuses minting and fee redirection |
| `scripts/validator-manager.ts` | The L1's validator set on the C-Chain: Ava Labs' ValidatorManager (vendored bytecode, `scripts/lib/validator-manager.json`) behind a proxy, PoAManager, a Safe owning both; initializes the set from the P-Chain's signed conversion |
| `scripts/tokenomics.ts` | The Minter's arithmetic over activity scenarios |
| `scripts/smoke-launch.ts` | One full-kit launch against a deployment, with its gas |

## How the pieces fit

```text
                    launch(name, symbol, supply, creator fee, holders' share, kit)
                                              │
     ┌──────────────┬──────────────┬──────────┴───────┬───────────────┬──────────────┐
  LaunchToken    V3 pool       LaunchLocker     LiquidityVault     credit (kit)   farm/zone/DAO
  votes +        11% tier,     full range,      full range,        3 markets in   Gauge, .zone,
  WCYBER         fee named     forever; fees →  ERC-20 shares      Lending, TWAP  Governor +
  dividend       by creator    creator/holders/                    oracles        Timelock
                               protocol
                                     │ protocol share                │ fee on interest
                                     ▼                               ▼
                               RevenueRouter ◄── pool protocol fees, names, predictions, NFT sales
                                │        │
              half to the pool's voters  rest as the coin: Furnace (burned) · gas tank · treasury
                                │                               │
                      Voter ◄── veASH votes weekly ── Minter makes ASH from burned CYBER
                                │
                             Gauges ── stream ASH (+ the project's own token) to LP stakers
```

Ways to earn, all on-chain: trading fees (LP vaults, auto-compounding), a creator's fee on their
launch, holder dividends, lending interest (directly or through a curated `CreditVault`), shorting
or leverage through the credit markets, ASH farming, veASH incentives and the protocol fees of the
pools you vote for, prediction markets in any token, NFT sales and royalties, curating a lending
vault, and liquidations.

## What replaced what

| Old (`crypto/hardhat`) | New | Why |
| --- | --- | --- |
| 25 copy-pasted bridged tokens, each owned by the relayer key (mint anything, burn from anyone) | `BridgedToken` × clones + `BridgeGateway` | a stolen relayer key mints one rate-limited bucket per asset, never touches a holder's balance; outbound transfers are escrowed until the payout is confirmed (capacity → payout → burn) |
| `CyberBridge`, `WrappedCyberSol`, `CyberSolSwap`, `CyberSolBurnSwap` | `BridgeGateway` | one door for every corridor |
| `Launchpad`, `LaunchpadNative`, `LaunchpadV3` | `Launchpad` | one launch, on V3, with the economy kit; the old V3 one could be bricked forever by creating the next token's pool first — the factory now refuses a pool for an address without code |
| `LaunchpadToken`, `LaunchToken` (0.7.6) | `LaunchToken` (0.8, clone) | votes on a timestamp clock, so a launched token has a DAO without wrapping |
| `MasterChef`, `FundedFarm`, `EmissionChannel` | `Minter` + `Voter` + `Gauge` + `Furnace` | ASH made from burned CYBER rather than a block schedule; directed by votes; a satellite chain's share is a gauge like any other |
| `Lending*` (Compound-style) | `Lending` + `AdaptiveCurveIrm` + oracles + `CreditVault` | the old markets could be drained: collateral shares were freely transferable, prices came from a V2 spot reserve, and an empty market's exchange rate could be inflated |
| `CyberiaProfile` nicknames, `CyberiaNames`, `CyberiaDomains` | `Domains` + `Badges` | one naming system; the primary name is the nickname; records reset on transfer |
| `DAOFactory`, `DAOGovernor`, `StakingVault` | `DAOFactory`, `TokenGovernor`, `VotesWrapper` | timestamp clock (Avalanche blocks come only with transactions), clones, no admin key left behind |
| `PredictionMarket` (CYBER only, trusted EOA oracle) | `PredictionMarket` | any currency, 2–8 outcomes, optimistic resolution with bonds |
| `NFTMarket` | `NFTMarket` | buyer's expected price, expiring listings, cancel-all, offers, ERC-1155, royalties |
| `FeeSplitter` | `RevenueRouter` | tracks native owed correctly across recipient changes; routes pool fees to that pool's voters |
| `CyberiaGasStation` | `GasStation` | same policy, under the shared authority |
| `TelegramTokenFactory`, `TokenFactory`, `VotingToken`, `TelegramChatToken` | `CommunityTokenFactory` + `CommunityToken` | the Telegram bot's `/create_token`: a mintable reward token for a chat, now on a timestamp clock so it can open a DAO; optional supply cap; owner can renounce minting |
| fixed-supply tokens (`CHATGPT`, `CLAUDE`, `OPENCLAW`, `HERMES`, `X`, `GitHub`, …), `CyberToken`, `Counter` | — | clean start: not carried over; a token that should exist again is launched through the `Launchpad` |
| QuickSwap V2 | — | one venue: V3 pools, with full-range `LiquidityVault`s where a fungible LP token is needed |

## Tokenomics: Fire and Ash

> **Being reworked (2026-10-21).** CYBER is CYBER.sol one for one (Wormhole NTT + ICTT, no bridge of
> our own), fees are small, and for now every fee pays the validators: gas goes to the validator that
> made the block (RewardManager with fee recipients), and RevenueRouter sends all protocol revenue to
> `validators` (deploy config: `router.validatorsWeight` 10,000, `votersBps` 0). What follows predates
> that and is kept until the new design replaces it.

Two coins, one rule: **CYBER is the fuel and only ever burns; ASH is what the fire leaves behind.**

### CYBER — fixed, backed, burning

- **1,000,000 CYBER, forever.** One CYBER for every 1,000 CYBER.sol on Solana — the rate the
  project has always published. Genesis (`scripts/genesis.ts`) refuses a chain that enables the
  NativeMinter precompile, so no CYBER can ever be created; the cap is a property of the chain.
- **Every CYBER on Cyberia is a CYBER.sol that crossed over.** Genesis credits the whole supply,
  less any direct allocations, to the bridge gateway's address (deployed later at exactly that
  address through CREATE2). The backing is visibly in place from block 0, and there is no
  premine: whoever wants CYBER — the team included — brings CYBER.sol across at 1000 : 1.
- **The fire.** CYBER leaves circulation for good in three ways, all readable on-chain:
  - transaction fees, which the chain burns into the blackhole address (genesis refuses fee
    redirection);
  - the `Furnace`, which burns into the same address: half of the protocol's CYBER revenue,
    and every `.cyber` name fee;
  - CYBER locked by launches. A launch puts the token's entire supply into its pool, so the CYBER
    paired with it can never come back out — even if every buyer sells, the position returns to at
    least what it started with. It is as gone as burned.
- **Mirror burn.** CYBER burned on Cyberia no longer backs any CYBER.sol, so the bridge burns the
  matching 1,000 × that amount of CYBER.sol from its Solana reserve. Using the chain shrinks the
  supply of the token that already trades — the existing community's asset.

### ASH — made only from fire

- **100 ASH for every CYBER of fire.** `Minter.updatePeriod` measures the week's fire (blackhole
  balance + `Launchpad.totalCyberLocked`, as deltas) and mints that many ASH. The 100,000,000 cap
  is 100 × CYBER's supply: all of ASH can only exist once all of CYBER has burned.
- **No week mints more than 1% of what is left** under the cap; heat above that burns without
  making ASH. This also bounds how fast a whale could turn burned CYBER into emissions.
- **Kindling.** 100,000 ASH in the first week, 4% less every week after (about 2.5M in all), so the
  farms have something before the fire is large. The fire is what lasts.
- **Each week's ASH:** 75% to the farms by veASH votes, 15% to the **builders' fund** (merged
  open-source work, in published Merkle rounds — the project's thesis that open source should be
  paid, made mechanical), 10% to the treasury.
- **No team allocation.** The only ASH before the fire is the **pioneer drop**: 5% of the cap for the
  people who bring CYBER.sol over in the first 12 weeks, pro rata, delivered as year-long veASH
  locks — the first voters are the first arrivals, and none of it is liquid on day one. Unclaimed
  drop goes to the builders.
- **What locking ASH earns:** the direction of emissions, half of the protocol fees of the pools you
  vote for, and every incentive projects pay for votes.

### Where every fee goes

| Source | Split |
| --- | --- |
| Launch pool trades (creator fee ≤ 10% + protocol 1%) | creator side to the creator and holders as they chose; the protocol's 1%: half to that launch's voters, half on to the coin split below |
| Other V3 pools (protocol share of LP fees) | half to that pool's voters, half on to the coin split |
| Protocol revenue in CYBER/WCYBER (the coin split) | for now 100% to the validators (before: 50% burned in the Furnace · 25% the gas station · 25% treasury) |
| Protocol revenue in other tokens | for now the validators (before: treasury) |
| Lending interest | fee set per market (≤ 25%) to the router |
| `.cyber` names | 100% burned |
| Token-zone names | the zone's token, burned |
| Predictions / NFT market | 2% / 2% to the router |
| Gas | the validator that made the block |

### The loop

```text
 use the chain ──► CYBER burns (gas, furnace, names, launch locks) ──► CYBER.sol burns on Solana
      ▲                         │
      │                         ▼
 deeper markets ◄── farms ◄── ASH minted from the fire ──► builders ──► better software
                        ▲                            │
                        └── veASH votes ◄── lockers paid by the fees of the pools they vote for
```

### What the numbers do

`node scripts/tokenomics.ts` runs the Minter's arithmetic on steady scenarios (CYBER of fire per
week). With the example config:

| Scenario | Fire / week | ASH after 1 year | after 5 years | from fire at 5 years | CYBER gone in 5 years |
| --- | --- | --- | --- | --- | --- |
| cold (today) | ~3 CYBER | 7.2M | 7.6M | 1% | 0.07% |
| village | 60 | 7.5M | 9.1M | 17% | 1.6% |
| town | 650 | 10.6M | 24.4M | 69% | 16.9% |
| city | 7,500 | 43.0M | 75.0M | 91% | 100% |

A chain nobody uses mints almost nothing beyond the drop and the kindling; ASH grows only as fast as
CYBER disappears.

### Enforced by code, and done by people

On-chain and in genesis: the fixed CYBER supply, fees burning, the furnace, the fire measurement,
the mint rate, ceiling and kindling, the 75/15/10 split's bounds (builders ≤ 25%, treasury ≤ 15%),
the drop's locks. Off-chain, published and checkable: the mirror burn on Solana (the relayer, weekly,
equal to 1,000 × CYBER burned), the pioneer list (from the gateway's release events), and the
builders' rounds (each with a link to the contributions it pays).

## Vendored PancakeSwap V3

Pool bytecode, and so `POOL_INIT_CODE_HASH` (`0x552a3c12…7e158`), is unchanged from the old chain's
fork. The factory has two Cyberia changes on top of the old fork's (mutable pool fee, creator's
one-time fee right, launch tier):

- `createPool` refuses a token address with no code (`NO_CODE`), which closes the launch-brick.
- a `feeCollector` (the RevenueRouter) may sweep protocol fees without a governance proposal.

`PancakeV3PoolDeployer.setFactoryAddress` can be called by anyone once; the deploy script calls it
right after deploying and stops if someone else got there first.

## Permissions

Every restricted function answers to `CyberiaAuthority`. See `contracts/access/Roles.sol`.

- **ADMIN** — the governance multisig, granted with an execution delay (`adminExecutionDelay`,
  48 h in the example): every admin call is scheduled in the authority and can be watched before it
  runs, so the authority is also the protocol's timelock. Admin can enable lending rate models and
  LLTVs, set fees within hard caps, configure bridge assets, and so on. It cannot move users'
  funds: there is no function anywhere that does.
- **GUARDIAN** — can only stop things: pause the bridge, block a name zone, retire a gauge.
- **OPERATOR** — the backend's key: gas drips, onboarding names, badges, operator prediction markets.
- **RELAYER** — the bridge relayer: release / finalize / refund, within rate limits.
- **LAUNCHPAD** — create gauges (the Launchpad contract, and governance).
- **ARBITER** — settles disputed prediction markets.

The DEX factory has a plain owner; the deploy script makes the authority its owner.

## Avalanche specifics

- **Time, never blocks.** An L1 block is produced when there is a transaction for it, so emission,
  interest, voting periods and commitment windows all count seconds.
- **EVM:** contracts compile for Cancun (subnet-evm since Etna: transient storage yes, blobs no);
  the vendored V3 stays on istanbul.
- **Gas:** a launch with the whole kit uses ~12.0M gas (`scripts/smoke-launch.ts`), under the
  16.7M per-transaction cap of EIP-7825. Set `feeConfig.gasLimit` to at least 15M; 20–30M is
  comfortable. `scripts/genesis.ts` refuses less than 15M.
- **Precompiles:** FeeManager (admin: the governance multisig) and Warp (ICM / ICTT with the
  C-Chain) on; **NativeMinter off** and **fees burning** (no fee recipients, no RewardManager
  redirect) — both are tokenomics, and `scripts/genesis.ts` refuses a genesis that breaks them.
- **Chain id and keys:** relaunching as chain 49406 with the old deployer key would let anyone
  replay that key's old transactions on the new chain, because its nonces start from zero again.
  Use a new chain id, new keys, or both.

## Keepers

Nothing here depends on a keeper for safety, but several things are better for one. All of these
calls are permissionless; the backend's scheduler should make them:

| Every | Call | Why |
| --- | --- | --- |
| 5 min | `V3TwapOracle.poke()` on every credit oracle (`Launchpad.economyOf(token).tokenOracle` / `cyberOracle`) | checkpoints keep the average a full window long even when a pool's observation ring is spammed; without them it gets staler, never shorter |
| week (Thursday 00:00 UTC) | `Minter.updatePeriod()`, then `Voter.distributeMany(gauges, epoch)` (or `rolloverUnvoted`) | turns the week's fire into ASH; a late call loses only that week's kindling |
| week | mirror burn: burn 1,000 × (CYBER burned since last time) CYBER.sol from the Solana bridge reserve, and publish the transaction | keeps CYBER.sol's supply equal to 1,000 × the CYBER that still exists |
| day | `RevenueRouter.harvestLaunch(positionId)` / `harvestPool(pool)` / `harvestLending(market)`, then `distribute(token)` / `distributeNative()` | pays voters their pools' fees and refills the gas tank |
| hour | `LiquidityVault.compound()` on active vaults | deposits and withdrawals compound anyway; this keeps quiet vaults' shares current |

## Relaunch checklist

1. Bring up the L1 (done on Fuji 2026-10-21, see `services/avalanche-node/README.md`):
   `node scripts/genesis.ts --network … --remote-deployer … --operator … --fee-admin … --out genesis.json`;
   `platform-cli subnet create`, `platform-cli chain create --genesis genesis.json`; point the node at
   the subnet; `node scripts/validator-manager.ts deploy` on the C-Chain; `platform-cli subnet
   convert-to-l1 --chain-id <C-Chain> --manager <ValidatorManager>` with every planned validator;
   `node scripts/validator-manager.ts init` through the signature-aggregator; start the ICM relayer.
   Check a new genesis with Subnet-EVM itself before `chain create`: the P-Chain accepts any bytes,
   and a chain whose genesis the VM refuses can never be fixed, only abandoned.
2. `npx hardhat build`, write a config from `deploy.config.example.json` with the real multisig,
   operator, relayer and treasury addresses, and run
   `RPC_URL=… DEPLOYER_PK=… node scripts/deploy.ts config.json`. Rehearse it first against
   `npx hardhat node` — it is resumable and records to `deployments/<chainId>.json`.
3. As admin (scheduled through the delay): `Minter.start(kindling)`; bridge corridors
   (`createWrapped`, `setAsset`, `setDestination`), starting with native CYBER ↔ CYBER.sol; after
   the 12-week migration window, `PioneerDrop.setRoot`.
4. Check the multisig can schedule and execute an admin call, then rerun with
   `renounceDeployer: true`.
5. `node scripts/smoke-launch.ts` against the new chain.

## Tests

```shell
npm install
npx hardhat test solidity
```

Solidity tests (forge-std, run by Hardhat 3) cover each module and a whole launch end to end
against the vendored V3 artifacts (`test/Economy.t.sol`). Note for test authors: the IR pipeline
may read `block.timestamp` *after* a `vm.warp` in the same test function, so tests that warp use
absolute times or epoch numbers computed before the warp.

## Not done yet

- **Frontends and backend.** The wallet, the Ritual DEX and Laravel speak the old contracts'
  ABIs. The new ones differ (one V3 venue, `Lending` instead of Compound-style markets, the
  gateway instead of owner-minted wrappers), so each integration has to be ported.
- **The relayer** has to call `BridgeGateway` (release / finalize / refund) instead of minting and
  burning wrappers directly, and the scheduler has to run the keeper calls above.
- **An audit.** The lending book and oracles follow well-studied designs, but this is new code
  holding money.
- **ICTT** for assets native to Avalanche (USDC on the C-Chain, AVAX) and for CYBER on the
  C-Chain: deploy Ava Labs' interchain token transfer contracts rather than relaying them.
- **PoS:** move the validator manager from PoA to `NativeTokenStakingManager` when the validator
  set should be open; staking rewards would then be minted through NativeMinter.
