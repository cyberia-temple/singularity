# Avalanche node

The validator of Cyberia's Avalanche L1 (Subnet-EVM). It replaces `services/cyberia-node`
(Polygon Edge), which is archived once the old chain's withdrawal window closes.

| File | What it is |
| --- | --- |
| `install.sh [fuji\|mainnet]` | Installs or upgrades one network's node: AvalancheGo and the Subnet-EVM plugin (pinned version and SHA-256), time sync, a 2 GB swapfile and the firewall. Each network is a node of its own (service, data dir, ports, identity), so one host runs both; a rerun restarts only that network's node. On a host that already has the firewall it only adds the node's staking port, live and to the file, and never reloads `nftables.conf` (a reload flushes the whole ruleset, with Docker's tables and any port opened for other services). Idempotent; run as root on Debian 13. |
| `node.json` | AvalancheGo config: Fuji, P-Chain only from the Primary Network (`partial-sync-primary-network`), tracks the L1's subnet, HTTP API on 127.0.0.1 |
| `avalanchego.service` | systemd unit, runs as the `avalanche` user, data in `/var/lib/avalanchego` |
| `nftables.conf` | a fresh host's firewall, inbound: SSH (22) and Avalanche p2p (9651) only |
| `mainnet/node.json`, `mainnet/avalanchego.service` | the mainnet node: `avalanchego-mainnet`, data in `/var/lib/avalanchego-mainnet`, HTTP API on 127.0.0.1:9660, p2p on 9661, OOM killer told to spare it |
| `mainnet/genesis.json`, `mainnet/chain.json` | the mainnet L1's genesis (chain id 49406, only the bridge's NativeTokenRemote mints) and its Subnet-EVM config; `feeRecipient` is the DAO Safe |
| `fuji/genesis.json` | the Fuji L1's genesis, written by `crypto/protocol/scripts/genesis.ts` (chain id 49407) |
| `fuji/upgrade.json` | scheduled precompile upgrades of the Fuji L1 (RewardManager, so that fees pay the validators). Every node carries the same file, and an entry that has activated stays in it forever |
| `fuji/chain.json` | the L1's Subnet-EVM config. `feeRecipient` is where this validator is paid the fees of the blocks it makes (burned if unset). `rpc-tx-fee-cap` (in CYBER) is far above the default 100, so that raising fees through FeeManager later does not make the node refuse transactions |
| `genesis-check/` | `check.sh <genesis.json> [fuji\|mainnet]` runs a genesis through Subnet-EVM of the pinned release, as the node will at chain creation. Run it before every `chain create` |
| `icm/` | `install.sh` adds Ava Labs' signature-aggregator (P-Chain messages for the validator manager, signed by the Primary Network) and ICM relayer (Teleporter between the C-Chain and the L1). The relayer's key lives only in `/etc/icm/relayer.env` |

## Running nodes

| Network | Host | Node ID |
| --- | --- | --- |
| Fuji | 91.132.163.19 (Senko, Frankfurt; 4 vCPU, 4 GB, 40 GB) | `NodeID-6VfUgV34HC4b6S7wu375cDmsUG3gzcHZ7` |
| Mainnet | the same host, `avalanchego-mainnet` (since 2026-11-24) | `NodeID-3ZQ8FRjf5htMpZNefbNcykNsmPWFJ2pm1` |

A node's identity is its data dir's `staking/` (TLS key and BLS `signer.key`). Losing it
loses the validator; copying it to a second running node splits it. Back it up encrypted, never
into this repository.

```shell
scp -r services/avalanche-node root@<host>:/root/ && ssh root@<host> bash /root/avalanche-node/install.sh
ssh root@<host> 'curl -s -X POST -H "content-type:application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"info.isBootstrapped\",\"params\":{\"chain\":\"P\"}}" \
  127.0.0.1:9650/ext/info'   # the mainnet node: install.sh mainnet, port 9660
```

The ICM relayer reads the C-Chain from publicnode.com (`icm/icm-relayer.json`), not Ava Labs' public API: that API answers `eth_getLogs` for at most 100 blocks, the relayer catches up in 200-block ranges, and on 2026-11-20…24 it restarted 70,000 times on that one error while nothing crossed from the C-Chain. A relayer that falls far behind catches up from `/var/lib/icm-relayer/<relayerID>.json`'s `latestProcessedBlock`.

The ICM signature-aggregator is installed but not running (`systemctl start signature-aggregator`): it holds over 1 GB of memory, and only `validator-manager.ts init` and validator changes need it; the ICM relayer collects its own signatures.

## Mainnet L1

| | |
| --- | --- |
| Subnet | `2LbFy4goShd9scLbts42CLC646hqfRtGUpqN4r84jMraBdX5mi` (owner `cyberia-mainnet-ops`, `P-avax19zfzk04gyyd3ld44w75wa94v26pe5uh99jrgsk`) |
| Blockchain | `2wT6Vohp7kxKpFuTSUAnbwKeVcWaH8XEBLdjXt1FNwK1erkvB7` (EVM chain id 49406), created 2026-11-23 from `mainnet/genesis.json` (sha256 `340821e2…87d9a`) |
| Minter | only `0xD6753b71C47A20b044D8124B1a45da25C4521dF9`: the second contract of `cyberia-mainnet-ictt` (`0xc9De…52f9`), the bridge's NativeTokenRemote proxy. Never send any other transaction from that key on the L1 |
| Fees | 1 wei for the setup, then 10 CYBER per transfer (FeeManager admin: ops); paid to the DAO Safe `0xae7a8d0A81617DDF94561e578e1A2deBB3Bcc25E` |
| Status | node syncing the P-Chain; not converted to an L1 yet |

## Fuji L1

| | |
| --- | --- |
| Subnet | `UVRXcqMkQM9X8Wv6BmXXEbFbAcbKoW1t8vde5Lds35SLQSVn3` |
| Blockchain | `Lm8HNjKAQ7ujA7XDphehkqbnu8wKjfzxpF1THX3HLyzoJhfv7` (EVM chain id 49407) |
| Converted | P-Chain tx `buRFjCjjieoJKmVztWFaYm8rNaN67FqLBiUDcsEHkeWiERGLu`, 2026-10-21 |
| Validator manager | `0xDF5D0Fd21440267A966e8AcD8B579a2d8B0ECCb0` on the Fuji C-Chain, owned by PoAManager `0x63E75b5805D673b514F5F5b37B6BB3aA11D27910`; both it and the ProxyAdmin belong to the Safe `0x96cd117786EBC0fDbef56a6559FEB2bd2BaE3393` (2 of 3 test keys). See `crypto/protocol/deployments/43113.json` and `scripts/validator-manager.ts` |
| ICM relayer | `0xEc2D561301e9A9cfd07DAB3524Aa6be6a5988480`, pays gas on both chains |
| Fees | minimum base fee 1 wei since block 25, set with `crypto/protocol/scripts/fee-config.ts` (genesis had 2.5·10¹⁵): a transfer costs about 10⁻¹² CYBER. Since 2026-10-21 11:06 UTC (`fuji/upgrade.json`) they go to the validator that made the block; before, they burned |

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
