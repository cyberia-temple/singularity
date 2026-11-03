# Cyberia VPN

A VPN node that lets in every address holding a running `CyberiaVpnPass`
(`crypto/hardhat/contracts/CyberiaVpnPass.sol`), and nobody else.

- **Protocol: VLESS + Reality + XTLS Vision (Xray).** WireGuard and OpenVPN are
  recognised and throttled by DPI in Russia and elsewhere; Reality borrows the
  TLS handshake of a real site (`VPN_REALITY_DEST`), so a probe of this host
  sees that site. Clients: Hiddify, v2rayN, v2rayNG, Nekobox, Streisand (iOS).
- **Payment: days of access in native CYBER.** `buy(user, days)` adds days to
  what is left. 90% goes to `treasury` (the operators' side — the VPN's
  `ServiceTreasury` once it exists, which pays the nodes by the second through
  `CyberiaCompute`), 10% to the protocol fee address
  `0x54BB8a86Fc001d5BB3e6C7ad2e2f153E5Fa6d7f6`. Nothing is held by the contract.
- **Access: the chain decides, the node obeys.** The node reads `PassBought`
  events and keeps Xray's client list equal to the set of running passes; an
  expired pass drops out within a poll (`VPN_POLL_SECONDS`, 30 s).
- **Credentials are derived, not stored.** An address's VLESS id is
  `HMAC(VPN_CLIENT_SECRET, address)`. Nodes sharing the secret give the same
  address the same id, and a node keeps no table of credentials to leak.
- **The wallet gets its link by signature.** `GET /api/vpn/challenge?address=`
  returns a nonce; the wallet signs `challengeMessage()` — built on both sides
  from address, node id and nonce, so a node can never get it to sign anything
  else — and `POST /api/vpn/link` answers with the `vless://` link (402 if the
  pass is not running). `GET /api/vpn/status` describes the node.

Traffic to private/loopback ranges and to port 25 is dropped, so a client can
reach neither this host's own services nor anybody's mail server.

## Run a node

```bash
cp .env.example .env
docker compose run --rm --entrypoint node vpn src/keygen.mjs >> .env
# fill in VPN_PASS_ADDRESS, VPN_PASS_FROM_BLOCK, VPN_PUBLIC_HOST, VPN_NODE_ID
docker compose up -d
docker compose --profile tls up -d   # gate over HTTPS on :8443 (needs port 80 free for the certificate)
```

Port 443 must be free on the host (Xray takes it). The wallet is an HTTPS page,
so it can only reach the gate over HTTPS: either the `tls` profile (Caddy,
Let's Encrypt via port 80) or an existing nginx proxying
`https://<host>/api/vpn/` to `127.0.0.1:8780`. Then add the node to
`VPN_NODES` in `backend/laravel/resources/js/lib/wallet/vpn.ts`.

## Verify

```bash
npm test
```

The Reality key derivation is pinned to the RFC 7748 X25519 vector and was
checked against `xray x25519 -i`; the generated config passes `xray run -test`.
