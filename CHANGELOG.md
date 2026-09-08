# Changelog

All notable project changes should be recorded here when a tagged release is cut.

This project uses date-based release tags:

```text
vYYYY.MM.DD
```

## Unreleased

### Added

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

1. Move completed entries from `Unreleased` into a dated release section.
2. Tag the commit with `vYYYY.MM.DD`.
3. Publish a GitHub release using the changelog section as release notes.
4. Link important deployed surfaces, contract addresses, and user-visible changes.
