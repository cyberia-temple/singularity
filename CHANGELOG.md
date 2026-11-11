# Changelog

Cyberia is a monorepo with **separate product and release timelines**. A commit, a testnet deployment, a downloadable build, and a public-store release are not the same event.

## Version tracks

| Track | Versioning | Meaning |
| --- | --- | --- |
| **Cyberia Wallet** | `1.x.x`, released as `app-vMAJOR.MINOR.PATCH` | Current wallet/application generation. Capabilities built during the old `0.x` period are being packaged and refined into independent wallet releases. A feature committed to the monorepo does not automatically ship in every app build or store edition. |
| **Cyberia platform — legacy** | `v0.x.x` app/site history | Existing changelog entries for the earlier, combined site and ecosystem. These remain available as historical records rather than being renumbered as wallet releases. |
| **Cyberia 2.0** | **Planned milestone, not released** | Reserve the 2.0 announcement for **both** an operational second chain beyond Fuji testing **and** Cyberia apps available in their intended marketplaces (e.g. Google Play, App Store, and browser-extension stores). Wallet support for Fuji alone does not satisfy this milestone. |
| **Monorepo / operations** | `vYYYY.MM.DD` date tags | GitHub source snapshots and infrastructure changes, independent of wallet app versions. |

See [release policy](docs/RELEASES.md). Live wallet distribution, testnet features, and future milestones must be labelled separately.

## Development updates — not yet assigned to a Wallet 1.x release

These entries describe changes merged into the repository as of **2026-11-10**. They are not claims that the corresponding feature is present in a published store build.

### Wallet 1.x — capabilities in development

- **Nov 10 — Elysium support:** Elysium (chain 99901, HYPE gas) added to the wallet network catalogue with token price lookup through a DEX index. This is network support, **not** an Elysium bridge or perpetuals interface. ([1423079](https://github.com/cyberia-temple/singularity/commit/14230791440a8a83145ebb38e90e9ad364ab3f0d))
- **Nov 9 — TokenStudio on Cyberia Fuji:** create and manage tokens from the wallet with capped or fixed supply, initial allocations, liquidity/fee settings, optional lending, farming and DAO modules, plus post-launch mint/burn controls. **Fuji/testnet; not Cyberia 2.0 production launch.** ([cf2daf1](https://github.com/cyberia-temple/singularity/commit/cf2daf147d982b8c1b1c6356e5534465013af13d), [f320c74](https://github.com/cyberia-temple/singularity/commit/f320c74ec8a3c3b590323b80957b9a61c68e4d87))
- **Nov 4–5 — Cross-chain swap UX:** new source/target network and token picker, Relay routes, SideShift integration with Ed25519 signing, Bitcoin quote fixes, and an ETH-on-Robinhood → BTC flow. ([942cc97](https://github.com/cyberia-temple/singularity/commit/942cc97c46cd92068082d61173943705af4c9ac0), [305cb17](https://github.com/cyberia-temple/singularity/commit/305cb17fb4d634b914c992046857d0f25716cfdb), [3a8e4c4](https://github.com/cyberia-temple/singularity/commit/3a8e4c41))
- **Nov 3–6 — More wallet surfaces:** NFT gallery/metadata and post-link fixes, 24-hour holdings and portfolio changes, mobile push notification wiring, and further extension/PWA work. Some store builds remain intentionally **social-only** during review. ([8095610](https://github.com/cyberia-temple/singularity/commit/80956104), [68a04ba](https://github.com/cyberia-temple/singularity/commit/68a04bac), [60b2c53](https://github.com/cyberia-temple/singularity/commit/60b2c53b), [92e14e0](https://github.com/cyberia-temple/singularity/commit/92e14e0e))

### Trading and ecosystem services

- **Nov 3 — OTC across five networks:** escrow-backed fixed-price offers, with separate books on Cyberia, Fuji, Robinhood Chain, Base, and BNB Chain; token-page prefill, Max with gas reserve, and explicit price summaries. The OTC contract itself has **no platform fee**. ([48f9e86](https://github.com/cyberia-temple/singularity/commit/48f9e868d325502b0a372a28466be42a0b98ac02))
- **Nov 4 — Referrals:** referrers receive 25% of the app's collected cross-chain swap fee attributable to referred users. Settlement is currently calculated weekly and **paid manually**. This is a share of the application fee, **not** an OTC fee. ([43545f1](https://github.com/cyberia-temple/singularity/commit/43545f19e0a18d7555394b2d6dd95a6a9a714a21))
- **Nov 2–3 — AI Arena:** open paper-trading league, MCP entry point for outside agents, portfolio charts, trade history and agent pages. Trades are simulated, not funded. ([5fdd456](https://github.com/cyberia-temple/singularity/commit/5fdd4566), [4a29562](https://github.com/cyberia-temple/singularity/commit/4a295622))

### Protocol and reliability

- **Nov 4 — Safer bridge recovery:** record signed transaction hashes before broadcasting and preserve payout/burn identity across timeouts and uncertain RPC replies to avoid accidental duplicate actions. ([ef9f043](https://github.com/cyberia-temple/singularity/commit/ef9f043f0341f486828684b91b7cbf6a5537e0cc))
- **Nov 4 — Second-chain groundwork:** Avalanche L1 protocol/node setup merged, while Cyberia Fuji remains the public test environment. Not a production release of Cyberia 2.0. ([0dbad3a](https://github.com/cyberia-temple/singularity/commit/0dbad3a480001f51e1bbb78d36c83a5ec986f3d2))

## Historical monorepo changelog (legacy 0.x and dated tags)

## Unreleased

### Added

- Cyberia 2.0 in the wallet: the new chain sits beside Cyberia as a second network that is always on, and the old one stays. Settings → Cyberia 2.0 opens its panel: what a transfer costs (and what the same transfer costs on Ethereum), where every fee goes, how long the validator's P-Chain balance lasts and when the chain would stop, the service wallets that must not run dry, and who can mint CYBER — all read from the chain. The account the chain lists as admin also gets the controls: set the transfer price (with a one-tap "like Ethereum" value from live prices), choose the fee recipient, top up a service wallet. Every change is a transaction that account signs in the wallet; no key for it lives on a server.
- Cyberia Fuji (`/fuji`, also `/faucet`): the new chain, Cyberia's Avalanche L1 on the Fuji testnet, added to MetaMask in one click, with its parameters listed for any other wallet. A faucet on the same page sends 10,000 test CYBER per address once a day from its own wallet. Fees there cost what an Ethereum mainnet transfer costs, counted in CYBER (about 151 CYBER for a transfer), and every fee goes to the DAO treasury; the page reads both from the chain itself.
- The swap page trades the new concentrated-liquidity pools as well as the old ones: both are asked what a trade pays and the better answer wins, with the venue and the pool's real fee shown beside the quote. Nothing moved — the old pools keep working and keep their liquidity.
- Swapping Monero, quoted two ways at once: through Cyberia's own bridge, and through a partner exchanger. Both are priced after every fee, the better one is marked, and the route that cannot run right now says why instead of disappearing.
- Launching a token on Cyberia now lets its creator set the trading fee themselves — anything up to 10%, decided at launch, on top of the 1% the protocol takes. Until now every launch charged whatever tier it landed in and the creator earned nothing from it.
- Holder fee sharing: a creator can hand any part of their own fee to the people holding the token. It arrives as a claimable balance that grows with every trade — nobody has to be paid by hand, nobody can be skipped, and giving it away costs the protocol nothing because it comes out of the creator's own share. Where the fee is the token itself, it is burned instead, which is the same gift to every holder.
- A launch's liquidity is still locked forever, and now it pays: the position keeps earning, and what it earns is split by the numbers the launch announced, collectable by anyone.
- Launchpad tokens can carry an X account, a Telegram and a website, shown on the token's card and editable afterwards by whoever created it.
- Telegram bot `/model`: the person asking picks which free model answers them. The default is a router over the whole free pool rather than one model, so the list is read from the provider itself — free is a price, not a name — the choice is remembered per person, and when a pinned model is busy the answer still arrives and says which model actually wrote it.
- Tracker (`/tracker`): a BitTorrent tracker where every release is minted as an NFT. The token is the publication — the index reads the owner and the description off the chain, refuses to announce a swarm nobody minted, and hides rather than deletes. Publishing, downloading and seeding all happen from the wallet; the desktop app creates the torrent and seeds it, which a browser tab cannot.
- A video and music player in the wallet: plays a release's pinned sample anywhere, and its files straight out of the swarm in the desktop app, with a playlist, seeking and a plain sentence for the containers no browser decodes.
- Cyberia Wallet browser extension (`frontend/extension`): Manifest V3 wallet with its own encrypted vault and an EIP-1193 provider for dapps, built for both Chromium and Firefox, published with the apps and offered at `/download`.
- LainOS: autonomous AI agent framework with a Cyberia chain plugin (`services/lainos`).
- Wired: 3D on-chain Godot game whose NPCs think via LainOS (`game/wired`).
- Cyberia L1 second-node config: non-validating full/RPC follower, prepared but not deployed (`services/cyberia-node`).
- NFT generator and PixelBattle surfaces.
- CyberSolSwap: on-chain `CYBER.sol` ↔ `CYBER` converter.
- Lending/farming UI and a CRM surface.
- Telegram bot inline buttons.
- Token listings (Yenten, Karasique, Goal) and Cyberia chain ID for DEXScreener integration.

### Changed

- The daily post is written on the machine whose writer is actually signed in. Two weeks of posts were answered by a host that had never finished `codex login`, so the schedule moved back to the desk; and a writer's refusal is now read instead of forwarded — the operator gets "out of credits until 11:33" rather than a wall of HTTP headers, and the room waits for the hour the writer named instead of retrying against a closed window every fifteen minutes.
- The operators' console room now tells LainOS the state of the project before it asks it anything: the queue, the machines, the chain (head, indexer lag, prices, the pool snapshot, the gas tank), the bridge ledger, the thirty-day numbers and the board — composed from the same caches the lenses render, dated, and with anything unreadable said rather than zeroed. The two backends are told different things about it: the daemon that it is a starting point for its own tools, the tool-less persona that it is the end of the line.
- Documentation now matches the actual tree: README repository map, "What Works Now" table, and architecture diagram cover `game/wired`, `services/lainos`, `services/telegram-bot`, and `services/cyberia-node`; `AGENTS.md` and `CLAUDE.md` document the second node. The gitignored `logs/` entry was dropped from the repository map.
- Refactored the Telegram bot and the analytics surface.

### Fixed

- The console's gas-tank row compared the station's figure, which is in wei, against a floor written in CYBER — so it could only ever fire once the tank was under sixty wei, which is to say never.
- Analytics and DCA bot fixes.

### Removed

- Untracked `frontend/ritual/.env.production` (now covered by `.gitignore`; its keys are templated in `.env.example`).
- Removed the stray root `key` public-key file and a stale `.gitmodules` that referenced nonexistent `frontend/hugo` and `frontend/blog` submodules.

## v2026.06.11 - 2026-06-11

### Added

- Public Laravel analytics surface at `/analytics`.
- Repository hygiene rules for local AI assistant state.
- Initial GitHub Actions CI for Laravel and EVM contracts.
- Issue templates for bugs, features, and first-time contributors.
- Ritual DEX environment template without secret values.

### Changed

- README now explains what Singularity is, how Cyberia/CYBER/CYBER.sol relate, where each component lives, and why the repository appears Elixir-heavy.
- Local `.env` files are ignored, and the tracked Ritual DEX `.env` was removed from git.

## Release Process

1. Distinguish **wallet app releases**, **platform releases**, and **unversioned development updates**.
2. For an app build, document its precise `app-vX.Y.Z` tag and actual distribution status; do not backfill older platform history as if those versions shipped in a store.
3. For monorepo snapshots, move completed items from `Unreleased` into a dated section and tag with `vYYYY.MM.DD`.
4. Publish GitHub release notes with verified deployed surfaces, contract addresses, and current limitations. See [docs/RELEASES.md](docs/RELEASES.md).
