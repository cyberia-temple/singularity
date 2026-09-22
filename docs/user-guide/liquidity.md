# Liquidity and farming

Putting two assets into a pool, staking what the pool gives you back, and
collecting what that earns. All of it can be done from the Cyberia Wallet
without leaving it.

<video src="/media/wallet-liquidity-farm-vertical-en-dark.mp4" controls playsinline preload="metadata" style="width:100%;max-width:340px;display:block;margin:1.5rem auto;border-radius:10px"></video>

<p style="text-align:center;font-size:0.85em;opacity:0.7;margin-top:-0.75rem">The whole sequence on the live chain, about two minutes. Captions are in the picture; the same text is in <a href="/media/wallet-liquidity-farm-vertical-en-dark.srt">an SRT file</a>.</p>

## What a pool is

A pool holds two assets together at one price. You put both sides in and get an
**LP token** — your claim on a share of the pool. Every trade that passes
through the pool pays a fee into that share, so an untouched position slowly
grows in the two assets underneath it.

Both sides come back out together, in whatever mix the pool holds by the time
you take them out. That mix is rarely the one you put in, which is the risk at
the bottom of this page.

## Adding liquidity

In the wallet: **Wallet → More → Liquidity**, tab **Add**.

1. Pick the two assets. The first is the network's own coin unless you change
   it; the second is any token the wallet can read.
2. Type **one** amount. The other box fills itself, because a pool that already
   exists has a price and that price fixes the second side exactly. A deposit
   that arrives at any other ratio is partly handed straight back by the router,
   so the wallet does not let you type both.
3. Read what comes back: the LP you will receive, your share of the pool
   afterwards, the floor on each side, and the network fee.
4. Choose a slippage tolerance. It becomes a **floor on both sides** written
   into the transaction — if the pool moves further than that before the
   transaction lands, the deposit reverts instead of going through at a ratio
   you did not agree to.
5. Hold the button to sign.

If either token needs an allowance first, the wallet says so and signs one for
**exactly this deposit's amount** — never an unlimited approval. That is a
separate transaction with its own fee, and it is priced into the figure you
read before you hold.

The position appears once the transaction is in a block. Broadcasting is not
settlement, so the wallet waits for the block rather than re-reading the chain
a moment too early and showing you nothing.

### Opening a pool that does not exist yet

If nobody has ever paired those two assets, your deposit **creates** the pool
and the ratio you type **becomes its price** — the first trade will be against
exactly that. The transaction also deploys the pool contract, which is why the
fee is an order of magnitude larger than an ordinary deposit's. The wallet says
both of these things on screen before you sign.

## Staking the LP token

An LP token earns trading fees on its own, sitting in your wallet. Staking it
in the farm earns the chain's emission on top.

In the wallet: **Wallet → More → Earn** (or the **Farm →** link on the
Liquidity screen).

1. Open the pool you hold LP in. The screen shows what is staked, what is in
   the wallet and not staked, what your share is worth in the two underlying
   assets, and the unclaimed reward.
2. Choose **Stake**, press **Max** or type an amount, and hold to sign.
3. The first stake also signs an allowance, again for exactly that amount.

Unstaking has no lock-up: **Unstake** takes it back in one transaction, and
anything the stake has earned is paid out at the same time.

## The reward

The farm pays per block. The wallet reads the pending reward once and then
carries it forward from the block it read it at, using the farm contract's own
arithmetic against the chain head — so the figure steps when the chain does
rather than sitting still until you reload the page.

**Claim** collects what has accrued and leaves the stake where it is. It is a
separate transaction with its own fee, so there is no point claiming a reward
worth less than the fee that collects it.

Two numbers on that screen are worth telling apart:

- **APR** is backward-looking — what the last day would have paid, annualised.
  It is not a forecast, and it does not net out the loss described below.
- **Unclaimed reward** is a fact about your address right now.

## Taking liquidity back out

**Liquidity → Your pools**, pick the position, choose how much of it to remove,
and hold to sign. You get both assets back in one transaction; where the pool
holds the network's wrapped coin, the wallet can unwrap it for you so the coin
arrives as the coin.

LP that is **staked in the farm is not listed there**. It has to come out of the
farm first — a pool cannot take back an LP token the farm is holding.

## What it costs you

While your assets sit in a pool, other people trade against them. If the two
prices move apart you get back more of the one that fell and less of the one
that rose. That difference is what the trading fees are paid for, and **no
number on these screens nets it out** — not the APR, not the reward.

A pool with very little in it moves a lot on a small trade. Check the pool's
size before deciding how much to put in, and remember that the share you are
buying is a share of exactly that.

## The same pools elsewhere

- <https://cyberia.church/liquidity> — the same v2 pools on the site, plus
  **V3 ranges**, where a position is an NFT holding a price range rather than a
  fungible LP token. A v3 position is not what the farm stakes.
- <https://swap.cyberia.church> — the Ritual DEX, with its own pools and farm
  pages.
- [DEX — swapping and liquidity](dex.md) — the trading side.
