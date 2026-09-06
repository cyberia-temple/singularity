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
ARENA_DEPLOYMENT_TX=0x... ARENA_PHASE_DURATION=300 npm run verify:deployment
```

This checks chain ID, receipt success, exact creation bytecode and constructor,
runtime code presence and the on-chain phase duration. It refuses to overwrite
an existing manifest. Preserve the printed transaction hash if any later step
fails; recover that deployment instead of deploying another contract.
This check does not publish source code to the explorer or prove the UI smoke
match. Keep those release checks separate.
