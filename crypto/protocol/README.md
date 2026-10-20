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
| `contracts/incentives` | `VotingEscrow` (veASH), `Voter`, `Gauge`, `Minter` |
| `contracts/treasury` | `RevenueRouter` — where every protocol fee arrives and where it goes |
| `contracts/bridge` | `BridgeGateway` and one `BridgedToken` implementation for every bridged asset |
| `contracts/identity` | `Domains` (the one naming system), `Badges` (soulbound achievements) |
| `contracts/governance` | `DAOFactory`, `TokenGovernor`, `VotesWrapper` |
| `contracts/predict` | `PredictionMarket` — any currency, 2–8 outcomes, optimistic resolution |
| `contracts/nft` | `CyberiaNFT` (open collection with royalties), `NFTMarket` |
| `contracts/community` | `CommunityToken` (mintable reward token with votes) and its factory |
| `contracts/apps` | `GasStation`, `PixelBattle`, `WiredForge`, `MinecraftLand` |
| `contracts/vendor` | PancakeSwap V3 core + periphery (two factory changes, below), Multicall3 |
| `scripts/deploy.ts` | Resumable deployment of everything, roles included |
| `scripts/genesis.ts` | Adds WCYBER, Multicall3 and the CREATE2 deployer to an Avalanche genesis |
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
              half to the pool's voters  rest split: treasury, GasStation tank (as the coin)
                                │
                      Voter ◄── veASH votes weekly ── Minter mints ASH (decaying, capped)
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
| `MasterChef`, `FundedFarm`, `EmissionChannel` | `Minter` + `Voter` + `Gauge` | emission by time, not blocks; directed by votes; a satellite chain's share is a gauge like any other |
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
- **Precompiles worth turning on in genesis:** RewardManager (send transaction fees to the
  RevenueRouter, so fees refill the gas station), FeeManager (admin: the governance multisig),
  NativeMinter (admin only; nothing here mints CYBER — validator rewards will, once PoS replaces
  PoA), Warp (for ICM / ICTT with the C-Chain).
- **Chain id and keys:** relaunching as chain 49406 with the old deployer key would let anyone
  replay that key's old transactions on the new chain, because its nonces start from zero again.
  Use a new chain id, new keys, or both.

## Relaunch checklist

1. Generate the L1 with avalanche-cli (PoA validator manager, precompiles above), then add the
   predeploys: `node scripts/genesis.ts genesis.json genesis.cyberia.json`.
2. `npx hardhat build`, write a config from `deploy.config.example.json` with the real multisig,
   operator, relayer and treasury addresses, and run
   `RPC_URL=… DEPLOYER_PK=… node scripts/deploy.ts config.json`. Rehearse it first against
   `npx hardhat node` — it is resumable and records to `deployments/<chainId>.json`.
3. As admin (scheduled through the delay): `Minter.start(weekly)`; bridge corridors
   (`createWrapped`, `setAsset`, `setDestination`); the RewardManager address.
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
  burning wrappers directly.
- **An audit.** The lending book and oracles follow well-studied designs, but this is new code
  holding money.
- **ICTT** for assets native to Avalanche (USDC on the C-Chain, AVAX) and for CYBER on the
  C-Chain: deploy Ava Labs' interchain token transfer contracts rather than relaying them.
- **PoS:** move the validator manager from PoA to `NativeTokenStakingManager` when the validator
  set should be open; staking rewards would then be minted through NativeMinter.
