# Uniswap v4 on Cyberia 2.0

The v4 contracts were deployed to Cyberia Fuji (chain 49407) on 28 October
2026. The verified addresses, deployment transaction hashes and gas used are in
`../hardhat/deployments/cyberia-v4-49407.json`. PoolManager is owned by the
Cyberia DAO 2-of-3 Safe. The Universal Router is configured for v4; v2, v3 and
the spoke pool are not configured.

The first CYBER / AVAX.FUJI pool is not yet initialized or funded. Its planned
static LP fee is 20,000 pips (2%), paid to liquidity providers. The protocol fee
is initially zero. The wallet's v4 swap screen supports this pair, checks the
actual pool fee before quoting and signing, and displays the net quote, minimum
output, estimated price impact, and maximum gas fee. The wallet code must be
built and deployed separately to reach users. The v4 PoolManager is
permissionless: its existence does not prevent other people from creating other
pools with different fees.

## Local tests

Run `npm ci` and `npm test` here. The tests compile Permit2 with its pinned
Solidity 0.8.17 settings, use a Cancun EVM with a 20 million gas block limit,
verify planned addresses and restart of a signed transaction, and exercise
PoolManager, Permit2, PositionManager, Quoter, StateView, Universal Router,
and the wallet's exact-input swap in both directions. The mock token and
Uniswap test liquidity/swap routers are fixtures, not production contracts.

## Deployment tooling

`node plan.mjs <rpc-url> <deployer-address> <pool-manager-owner>` is read-only.
It checks chain 49407, the sender's pending nonce, predicted contract addresses
and initcode hashes. Predictions become invalid if the nonce changes.

`node --env-file=../hardhat/.env deploy.mjs --broadcast` signs and broadcasts
real transactions. It persists each signed transaction before broadcasting,
resumes the same hash after an interruption, rejects nonce and network changes,
and does not replace a pending transaction. Its checkpoint is the deployment
file above: do not delete or edit it while a transaction may be pending. The
script currently uses the DAO Safe as PoolManager owner and a gas-price cap of
0.0003 CYBER per gas. Obtain approval for any new deployment before running it.
