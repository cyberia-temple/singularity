# Development

Run all commands from `game/SDK`:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

`pnpm build` compiles Solidity with Hardhat and type-checks the TypeScript
configuration and scripts. `pnpm test` runs the Hardhat test runner.

Contracts target the `paris` EVM instruction set for compatibility with the
current Cyberia node instead of assuming newer Cancun opcodes.

## Networks

| Network          | Chain ID | Purpose                         |
| ---------------- | -------: | ------------------------------- |
| `hardhatMainnet` |    31337 | Local deterministic development |
| `cyberia`        |    49406 | Cyberia Network                 |

The Cyberia RPC defaults to `https://rpc.cyberia.church`. Set
`CYBERIA_RPC_URL` to use a different compatible endpoint. A private key is not
required to compile or test; `CYBERIA_PRIVATE_KEY` is read only when present.

For production compilation, use the optimizer profile:

```bash
pnpm exec hardhat build --build-profile production
```
