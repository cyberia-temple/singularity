# Cyberia Wallet — privacy policy

_Applies to the Cyberia Wallet browser extension. Last updated 2026-10-29._

Cyberia Wallet is non-custodial. Your recovery phrase and private keys are
created on your device, encrypted with your password, and stored only in your
browser. They are never sent to Cyberia or to anyone else, and nobody — Cyberia
included — can recover them for you.

## What leaves your browser, and why

A wallet has to ask the blockchain about your account, so some data is sent to
the services that answer for each network:

- **Your public account address** is sent to the network's RPC node and token
  index to read your balances and tokens: rpc.cyberia.church and
  explorer.cyberia.church (run by Cyberia) for Cyberia; the public RPC services
  of Robinhood Chain, BNB Chain and Base for those networks, and
  robinhoodchain.blockscout.com for Robinhood Chain tokens.
- **Transactions you approve** are sent to that network's RPC node to be
  broadcast. Once on a blockchain, a transaction is public and permanent.
- **Requests from sites you connect**: when you connect a website, its
  read-only requests to the blockchain (for example, a token balance or a
  contract call) are passed to the network's RPC node. A site can ask you to
  sign something; nothing is signed or sent until you approve it in the wallet.
- **Extension usage**: when you allow technical and interaction data, opening
  the wallet sends a random installation identifier and an opening event to
  Cyberia, which forwards it to Google Analytics. No wallet address, browsing
  history, page contents, recovery phrase or password is included.
- **Prices**: the wallet asks https://cyberia.church/api/wallet/prices for USD
  prices. That request contains no address and no identifier.

These services see your IP address, as any web request does. If you turn on the
relay, the wallet's requests go through a SOCKS5, Tor or I2P service you run
yourself instead of directly. In Firefox the relay carries only the wallet's own
requests; Chrome lets an extension set one proxy for the whole browser, so
there it carries every tab, and the wallet says so before you turn it on.

## What is not collected

No crash reports, advertising identifiers or browsing history. The extension only runs on websites you connect, and it does
not read their content.

## What is stored on your device

The encrypted vault, the list of sites you connected and the accounts each may
see, your settings, a random analytics installation identifier, and while unlocked, the key that opens the vault (in
session storage, cleared when the browser closes). Removing the extension
deletes all of it — keep your recovery phrase, it is the only way back.

## Contact

https://cyberia.church
