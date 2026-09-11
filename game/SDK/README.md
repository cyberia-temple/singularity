# Cyberia Arcade SDK

Reusable infrastructure for blockchain games on Cyberia Network. The first
reference game is Rock–Paper–Scissors with commit–reveal moves, escrowed native
CYBER stakes, timeout forfeits and pull-based payouts.

## Requirements

- Node.js 22 or newer
- pnpm 11.3.0

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

The default local Hardhat network uses chain ID `31337`. The `cyberia` network
uses chain ID `49406` and `https://rpc.cyberia.church` unless
`CYBERIA_RPC_URL` overrides it. Copy `.env.example` to `.env` and set
`CYBERIA_PRIVATE_KEY` only when a script needs to sign a transaction.

Never commit `.env` or a private key.

The contract lifecycle, commitment encoding, payout rules and bounded wallet
discovery protocol are documented in [`docs/RPS_SPEC.md`](docs/RPS_SPEC.md).
The contract and wallet vertical slice are implemented and tested. The MVP is deployed at
`0xd21edE559b49A6f6cDF57060456474D100D53e45` with a 300-second phase duration.
The deployment manifest in `deployments/` was recovered from the creation
transaction and checked against the production build and on-chain parameter.
Explorer source verification passed. A two-wallet mainnet UI smoke match and
a durable event indexer remain outstanding.

Deployment writes an address-specific manifest and prints the transaction hash
before waiting for confirmation. To recover a manifest after an interrupted
run (no signing required):

```bash
ARENA_RULES_VERSION=1 ARENA_DEPLOYMENT_TX=0x... ARENA_PHASE_DURATION=300 npm run verify:deployment
```

This checks chain ID, receipt success, exact creation bytecode and constructor,
runtime code presence and the on-chain phase duration. It refuses to overwrite
an existing manifest. Preserve the printed transaction hash if any later step
fails; recover that deployment instead of deploying another contract.
This check does not publish source code to the explorer or prove the UI smoke
match. Keep those release checks separate.

## Asynchronous challenges (new deployment)

`RockPaperScissorsAsync` implements the revised single-round rules. Challenges
wait indefinitely. Acceptance escrows the second stake but does not start play.
Both players must confirm readiness; each acknowledgement is valid for ten
minutes without a penalty for expiry. Until both are ready, either participant
may cancel and both deposits become claimable. Once started, commit and reveal
each have a fixed 600-second deadline.

On timeout, each inactive player's own stake accrues to the immutable Arena
treasury; an active player gets their own stake back. If neither acts, both
stakes accrue to the treasury. Normal outcomes and draws are unchanged. Timeout
settlement and `claimTreasury(gameId)` are permissionless transactions; they do
not run automatically, and a treasury transfer cannot block settlement or a
player's separate refund.

Set `ARENA_TREASURY_ADDRESS` explicitly before `npm run deploy:cyberia`. There is
no default treasury. The command now deploys the asynchronous contract;
`deploy:legacy` retains the original script. Recover a new manifest using
`ARENA_RULES_VERSION=2`, `ARENA_TREASURY_ADDRESS` and `ARENA_DEPLOYMENT_TX` with
`npm run verify:deployment`. The new contract is not deployed by this code change.

The wallet reads the rules from the configured contract before enabling creation.
Changing `ARENA_CONTRACT_ADDRESS` selects the new deployment after verification.
New invitation links include its address; links without an address still resolve
to the original deployed MVP. Only the configured and original addresses are
accepted from invitations. Both versions retain their own encrypted secrets,
game IDs and payout paths. The current 50-game discovery window remains bounded:
older challenges can still be opened by invitation or ID but need an indexer
to stay discoverable in a growing feed.

Spectator bets, token conversion, stake changes between rounds, scheduled duels
and background notifications are separate future features, not part of these
revised timeout rules.
