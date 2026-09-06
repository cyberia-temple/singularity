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
The contract and wallet vertical slice are implemented and tested. Deployment
to Cyberia, a two-wallet mainnet smoke match and a durable event indexer are
the remaining production milestones.
