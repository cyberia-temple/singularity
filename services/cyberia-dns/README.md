# Cyberia DNS

Domains that are NFTs, in zones that tokens open — kept on Cyberia and
answered as ordinary DNS.

- **Registry:** `CyberiaDomains` at `0xA827D058a5738EaC28DB1d658D3e8cFb82CBb66B`
  on chain 49406 (`crypto/hardhat/contracts/CyberiaDomains.sol`,
  `deployments/cyberia-domains.json`). It superseded `CyberiaNames`
  (`0xc66e…F7B9`, `.cyber` only, not NFTs) on 2026-10-07; the reserved names
  moved over with their records.
  - A **domain** (`lain.moon`) is an ERC-721, token id
    `keccak256("lain.moon")`; whoever holds it writes its records.
  - A **zone** is `.cyber` (paid in CYBER, `cyberPrice`, 1 CYBER) or a
    launchpad token named `.<zone>` with the ticker `DOT<ZONE>`:
    `createZone(token)` checks LaunchpadNative (`pairOf`) / LaunchpadV3
    (`poolOf`) listed it and the name/ticker spell a DNS label, and opens the
    zone for anyone who calls it. A name in a token zone costs
    `totalSupply / feeDivisor` (1e6) of that token, **burned** — the
    launchpads keep no creator on chain, so a zone has no owner to pay.
  - The wallet opens the zone right after a launch whose name spells one;
    a token launched elsewhere gets it from Wallet → NFT → Domains.
- **Server:** this directory — `node:22-alpine`, standard library only, source
  mounted read-only. Plain DNS on `2.26.24.177:53` and
  `[2a12:bec4:1bb0:1ba1::2]:53` (UDP + TCP), DoH at
  `https://dns.cyberia.church/dns-query` (RFC 8484), and a JSON view for the
  wallet's browser: `/api/zones`, `/api/resolve?name=`.

## Which zones are served

The contract's (`zones()`, re-read every minute), minus any zone the **real
DNS root already delegates**: each is checked with `NS <zone>.` upstream and
anything but NXDOMAIN keeps it off — otherwise a token named `.com` would make
this server answer for every .com name its DoH users look up. The check fails
closed (an unanswered check is not served) and RFC 6761-style names
(`localhost`, `local`, `onion`, `test`, …) are never served. `.cyber` is
trusted. A blocked zone (`blockZone`, abuse only) is dropped too.

## Records

The contract stores `key → string`; the server turns keys into answers and
validates every value (an invalid record is skipped, never served):

| key | answer | value |
|-----|--------|-------|
| `A`, `AAAA` | addresses | one or more, space/comma separated |
| `CNAME` | alias, answers every other type | a hostname |
| `TXT` | text | one string per line |
| `MX` | mail | `10 mx.example.com`, one per line |
| `url` | a browser visit redirects here | an `http(s)://` address |
| `ipfs` | `_dnslink.<name>` TXT `dnslink=/ipfs/<cid>`; a visit goes to the IPFS gateway | a CID or `/ipns/…` path |
| `addr` | `_addr.<name>` TXT | an address (defaults to the owner) |
| `<sub>/<TYPE>` | `<sub>.<name>.cyber` | as above, e.g. `www/CNAME` |
| `*/<TYPE>` | any sub-name without its own records | as above |

The wallet edits these by intent (a link, an IPFS page, a server, another
name — each clears the others) with the raw records one fold down.

Unregistered names are `NXDOMAIN`; a registered name without the asked type is
`NODATA`; a chain that cannot be read is `SERVFAIL` — never `NXDOMAIN`, because
"the RPC did not answer" is not "this name does not exist". Answers are cached
30 s per name, TTL 60.

## In a browser

The wallet's browser (The Wired, `WalletBrowse.vue`) resolves names through
`/api/resolve` and shows the target in a sandboxed frame — never with
`allow-same-origin` for this site's own origin, where the vault lives. A
server-only (`A`/`AAAA`) name is plain HTTP, which an https page cannot frame,
so it offers a new tab instead.

A name that resolves to this host (directly or through a CNAME) lands on the
site's nginx, whose `:80 default_server` hands every unknown Host to the gateway in
`src/server.mjs` — plain HTTP, since no CA certifies a TLD outside the root.
The gateway redirects by the name's records — `url` (an `https://` address),
then `CNAME` (`cyberia.cyber` → `https://cyberia.church/`), then `ipfs`
(`$IPFS_GATEWAY/ipfs/<cid>`) — and otherwise shows a card naming the owner.

With RD set, a CNAME is chased to its address (inside our zones always, outside
them on TCP/DoH only), because stub resolvers — curl, Firefox's DoH — will not
ask again by themselves.

## Zones

`DNS_ALIASES` (default `cyber.cyberia.church=cyber`) repeats a chain zone under
a delegated real domain. `.cyber` is not an ICANN TLD, so it resolves only for clients pointed at
this server (DoH in a browser, or system DNS). The second zone makes every
name reachable from **any** resolver once `cyber.cyberia.church` is delegated:
at Namecheap → Advanced DNS add `NS cyber → ns1.cyberia.church.` (ns1 already
resolves to 2.26.24.177 through the wildcard).

## Forwarding

Names outside the zones are forwarded to `DNS_UPSTREAM` over TCP and DoH, so
`dns.cyberia.church/dns-query` works as a browser's only resolver. Over plain
UDP they are `REFUSED` unless `DNS_FORWARD_UDP=1`: UDP sources are forgeable,
and an open UDP recursor is an amplifier aimed at whoever an attacker names.
UDP is also rate-limited per source (`DNS_UDP_QPS`, default 20).

## Run

```bash
npm test                        # unit tests, no network
docker compose up -d            # on cyber.main; joins docker-compose_default
dig @2.26.24.177 dns.cyber A    # → 2.26.24.177
curl https://dns.cyberia.church/api/zones
```

The DoH vhost is `services/blockscout/docker-compose/proxy/dns.conf.template`.
The proxy renders templates at start; to apply without recreating it:

```bash
docker exec proxy sh -c 'envsubst "$(printf "\${%s} " $(env | cut -d= -f1))" \
  < /etc/nginx/templates/dns.conf.template > /etc/nginx/conf.d/dns.conf && nginx -t && nginx -s reload'
```

Deploying the contract again: `crypto/hardhat/scripts/deploy-domains.ts`
(explicit gas, nonces from `latest` only — the deployer is the shared relayer
EOA).
