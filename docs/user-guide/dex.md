# DEX — Swapping

There are two trading surfaces, backed by the same on-chain QuickSwap-style (Uniswap v2) pools:

- **Ritual DEX** — <https://swap.cyberia.church>: the full DEX with swap, pools, farm, and wrap pages.
- **In-app swap** — <https://cyberia.church/swap> and <https://cyberia.church/liquidity> on the main site.

Both need a connected EVM wallet on the Cyberia network and a little CYBER for gas ([getting started](getting-started.md)).

## Before you swap

1. Confirm the wallet is on Cyberia, chain ID `49406`.
2. Confirm the input token balance and a separate CYBER balance for gas.
3. If you imported a token manually, compare its contract with [Tokens and contracts](tokens.md).
4. Decide the largest price impact you are comfortable accepting before opening the wallet confirmation.

## Swapping

1. Connect your wallet and pick the input token, output token, and amount. Native CYBER can be traded directly — the router wraps or unwraps it automatically.
2. Review the quote: expected output, rate, price impact, minimum received, and route. The router searches across liquidity pools with multi-hop routes, so pairs without a direct pool can trade through intermediate tokens.
3. For an ERC-20 input, confirm the approval transaction when requested and wait for it to complete.
4. Return to the quote, choose **Swap**, and review the final amounts in the wallet.
5. Confirm the swap transaction.
6. Open its transaction hash and confirm the output token in the wallet or explorer.

Tips:

- **Watch price impact.** Some pools are small; a large order against a shallow pool moves the price a lot. The UI shows the impact before you confirm.
- **"No route with liquidity found"** means no pool path currently connects those two tokens with enough liquidity — try a smaller amount or route manually via CYBER or USDC.

## Providing liquidity

Adding liquidity, staking the LP token you get back and claiming what it earns
have a page of their own, with a video of the whole sequence:
[Liquidity and farming](liquidity.md).

The short version: you deposit both tokens at the current pool ratio and receive
LP tokens representing your share, trading fees accrue to the pool, and you can
redeem the LP tokens at any time. The value of the position follows the pool's
token ratio, and a displayed APR is backward-looking.

To add liquidity:

1. Open the pool and choose **Add liquidity**.
2. Enter one token amount; the interface calculates the matching amount at the current pool ratio.
3. Approve each ERC-20 that the router is not yet allowed to use.
4. Review the two deposit amounts and the slippage setting.
5. Confirm the liquidity transaction.
6. Verify that the LP balance or position appears on the pools page.

Providing liquidity earns the on-chain **Liquidity Farmer** achievement; a first swap earns **First Exchange** ([profile](account-and-profile.md#achievements)).

## Farm and Wrap

Ritual also has:

- **Farm** — stake LP tokens in reward farms where available.
- **Wrap** — wrap/unwrap native CYBER ↔ WCYBER (`0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9`) manually. Normally you don't need this; the swap pages handle wrapping for you.

## Getting tokens to trade

Assets arrive on Cyberia through the [bridge](bridge.md). The full list of tradable assets and their contract addresses is in [tokens.md](tokens.md); live token pages with prices are at <https://cyberia.church/tokens>.
