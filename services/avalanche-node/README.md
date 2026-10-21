# Avalanche node

The validator of Cyberia's Avalanche L1 (Subnet-EVM). It replaces `services/cyberia-node`
(Polygon Edge), which is archived once the old chain's withdrawal window closes.

| File | What it is |
| --- | --- |
| `install.sh` | Installs or upgrades AvalancheGo and the Subnet-EVM plugin (pinned version and SHA-256), time sync, a 2 GB swapfile and the firewall. Idempotent; run as root on Debian 13. |
| `node.json` | AvalancheGo config: Fuji, P-Chain only from the Primary Network (`partial-sync-primary-network`), tracks the L1's subnet, HTTP API on 127.0.0.1 |
| `avalanchego.service` | systemd unit, runs as the `avalanche` user, data in `/var/lib/avalanchego` |
| `nftables.conf` | inbound: SSH (22) and Avalanche p2p (9651) only |
| `fuji/genesis.json` | the Fuji L1's genesis, written by `crypto/protocol/scripts/genesis.ts` (chain id 49407) |
| `fuji/chain.json` | the L1's Subnet-EVM config. `rpc-tx-fee-cap` (in CYBER) is far above the default 100, so that raising fees through FeeManager later does not make the node refuse transactions |
| `genesis-check/` | `check.sh <genesis.json> [fuji\|mainnet]` runs a genesis through Subnet-EVM of the pinned release, as the node will at chain creation. Run it before every `chain create` |
| `icm/` | `install.sh` adds Ava Labs' signature-aggregator (P-Chain messages for the validator manager, signed by the Primary Network) and ICM relayer (Teleporter between the C-Chain and the L1). The relayer's key lives only in `/etc/icm/relayer.env` |

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

## Fuji L1

| | |
| --- | --- |
| Subnet | `UVRXcqMkQM9X8Wv6BmXXEbFbAcbKoW1t8vde5Lds35SLQSVn3` |
| Blockchain | `Lm8HNjKAQ7ujA7XDphehkqbnu8wKjfzxpF1THX3HLyzoJhfv7` (EVM chain id 49407) |
| Converted | P-Chain tx `buRFjCjjieoJKmVztWFaYm8rNaN67FqLBiUDcsEHkeWiERGLu`, 2026-10-21 |
| Validator manager | `0xDF5D0Fd21440267A966e8AcD8B579a2d8B0ECCb0` on the Fuji C-Chain, owned by PoAManager `0x63E75b5805D673b514F5F5b37B6BB3aA11D27910`; both it and the ProxyAdmin belong to the Safe `0x96cd117786EBC0fDbef56a6559FEB2bd2BaE3393` (2 of 3 test keys). See `crypto/protocol/deployments/43113.json` and `scripts/validator-manager.ts` |
| ICM relayer | `0xEc2D561301e9A9cfd07DAB3524Aa6be6a5988480`, pays gas on both chains |
| Fees | minimum base fee 10¹² wei (the replay floor) since block 22, set with `crypto/protocol/scripts/fee-config.ts`; genesis had 2.5·10¹⁵. A transfer costs 0.021 CYBER |

The subnet `YFWTudceybPm15VZjF1CBNnfqG9vE9uz555Cp81ErYXyzNqk7` and its chain `EXEuF3BXo12NYY888NQnr5TKTz9LP7bv531aceLhv78627PBF`
are a first attempt whose genesis Subnet-EVM refused (Warp before Durango). They cost nothing to leave; do not track them.

The validator's P-Chain balance, which anyone can top up:

```shell
platform-cli l1 increase-validator-balance --network fuji --key-name <funded P-Chain key> \
  --validation-id 2KZnTnX6QqZ1WNAFd7BCp9cKgXWYd3MXoj1zpccdSfVG14ULLJ --balance <AVAX>
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
