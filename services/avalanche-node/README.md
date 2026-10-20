# Avalanche node

The validator of Cyberia's Avalanche L1 (Subnet-EVM). It replaces `services/cyberia-node`
(Polygon Edge), which is archived once the old chain's withdrawal window closes.

| File | What it is |
| --- | --- |
| `install.sh` | Installs or upgrades AvalancheGo and the Subnet-EVM plugin (pinned version and SHA-256), time sync, a 2 GB swapfile and the firewall. Idempotent; run as root on Debian 13. |
| `node.json` | AvalancheGo config: Fuji, P-Chain only from the Primary Network (`partial-sync-primary-network`), HTTP API on 127.0.0.1 |
| `avalanchego.service` | systemd unit, runs as the `avalanche` user, data in `/var/lib/avalanchego` |
| `nftables.conf` | inbound: SSH (22) and Avalanche p2p (9651) only |
| `fuji/genesis.json` | the Fuji L1's genesis, written by `crypto/protocol/scripts/genesis.ts` (chain id 49407) |

## Running nodes

| Network | Host | Node ID |
| --- | --- | --- |
| Fuji | 91.132.163.19 (Senko, Frankfurt; 4 vCPU, 4 GB, 40 GB) | `NodeID-6VfUgV34HC4b6S7wu375cDmsUG3gzcHZ7` |

The node's identity is `/var/lib/avalanchego/staking/` (TLS key and BLS `signer.key`). Losing it
loses the validator; copying it to a second running node splits it. Back it up encrypted, never
into this repository.

```shell
scp -r services/avalanche-node root@<host>:/root/ && ssh root@<host> bash /root/avalanche-node/install.sh
ssh root@<host> 'curl -s -X POST -H "content-type:application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"info.isBootstrapped\",\"params\":{\"chain\":\"P\"}}" \
  127.0.0.1:9650/ext/info'
```

## What to watch

Blocks come only with transactions, so a quiet chain is healthy. Watch instead: `/ext/health`,
peers, P-Chain bootstrapped, the validator's P-Chain balance (an L1 validator pays about
1.33 AVAX a month and turns inactive at zero — which stops a one-validator chain) and the ICM
relayer's lag.

## Validators and liveness

The chain is live while more than 75% of its stake is online (Snowman, `α/k = 15/20`). With equal
weights, 1–4 validators survive no failure — a second validator makes the chain *less* available,
not more — and five survive one, slowly. Mainnet therefore starts with one validator and a cold
standby at another provider, then grows to five, each at its own provider. Put every planned
validator in the conversion: afterwards the validator manager adds at most 20% of the weight a day.
