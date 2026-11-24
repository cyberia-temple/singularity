#!/usr/bin/env bash
# Installs (or upgrades) AvalancheGo and the Subnet-EVM plugin as a systemd service.
# Idempotent: rerun after changing the pinned version below. Run as root on Debian 13.
#
#   install.sh [mainnet]
#
# The Fuji node (49407) was retired on 2026-11-24; its files under fuji/ are the record of that chain.
set -euo pipefail

AVALANCHEGO_VERSION="v1.15.1"
AVALANCHEGO_SHA256="6d57678a0fb9cc90eea31aa86bfdf582f79ec5187162672123c0fbd0d473ff78"
SUBNET_EVM_SHA256="984090867966368608fa2a46353030352d0e8d0b20029c022a3755b991432e21"
# Subnet-EVM's default VM ID: the plugin file must carry this name.
SUBNET_EVM_VM_ID="srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy"

NETWORK="${1:-mainnet}"
# The L1's blockchain ID (its subnet is track-subnets in the node config), and where the node keeps its data.
case "${NETWORK}" in
  mainnet)
    SERVICE="avalanchego-mainnet"
    DATA_DIR="/var/lib/avalanchego-mainnet"
    NODE_CONFIG="/etc/avalanchego/mainnet.json"
    STAKING_PORT=9661
    L1_BLOCKCHAIN_ID="2wT6Vohp7kxKpFuTSUAnbwKeVcWaH8XEBLdjXt1FNwK1erkvB7"
    ;;
  *)
    echo "usage: $0 [mainnet]" >&2
    exit 64
    ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
# The node config, the systemd unit and the L1's chain config.
NODE_JSON="${HERE}/${NETWORK}/node.json"
UNIT="${HERE}/${NETWORK}/avalanchego.service"
L1_CHAIN_CONFIG="${HERE}/${NETWORK}/chain.json"
# Scheduled precompile upgrades. Every node must carry the same file, and an applied entry stays forever.
L1_UPGRADE="${HERE}/${NETWORK}/upgrade.json"

RELEASES="https://github.com/ava-labs/avalanchego/releases/download/${AVALANCHEGO_VERSION}"
TARGET="/opt/avalanchego/${AVALANCHEGO_VERSION}"
CHAIN_DIR="${DATA_DIR}/configs/chains/${L1_BLOCKCHAIN_ID}"

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl jq nftables systemd-timesyncd unattended-upgrades >/dev/null
systemctl enable --now systemd-timesyncd
timedatectl set-ntp true

if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id avalanche >/dev/null 2>&1 || useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin avalanche
install -d -o avalanche -g avalanche -m 750 "${DATA_DIR}" "${DATA_DIR}/plugins"
install -d -m 755 /etc/avalanchego

download() {
  local name="$1" sha="$2"
  curl -fsSL -o "/tmp/${name}" "${RELEASES}/${name}"
  echo "${sha}  /tmp/${name}" | sha256sum -c --quiet -
}

if [ ! -x "${TARGET}/avalanchego" ]; then
  install -d "${TARGET}"
  download "avalanchego-linux-amd64-${AVALANCHEGO_VERSION}.tar.gz" "${AVALANCHEGO_SHA256}"
  download "subnet-evm-linux-amd64-${AVALANCHEGO_VERSION}.tar.gz" "${SUBNET_EVM_SHA256}"
  work="$(mktemp -d)"
  tar -xzf "/tmp/avalanchego-linux-amd64-${AVALANCHEGO_VERSION}.tar.gz" -C "${work}"
  tar -xzf "/tmp/subnet-evm-linux-amd64-${AVALANCHEGO_VERSION}.tar.gz" -C "${work}"
  install -m 755 "$(find "${work}" -type f -name avalanchego | head -1)" "${TARGET}/avalanchego"
  install -m 755 "$(find "${work}" -type f -name subnet-evm | head -1)" "${TARGET}/subnet-evm"
  rm -rf "${work}" /tmp/avalanchego-linux-amd64-*.tar.gz /tmp/subnet-evm-linux-amd64-*.tar.gz
fi
ln -sfn "${TARGET}" /opt/avalanchego/current
install -o avalanche -g avalanche -m 755 "${TARGET}/subnet-evm" "${DATA_DIR}/plugins/${SUBNET_EVM_VM_ID}"

install -m 644 "${NODE_JSON}" "${NODE_CONFIG}"
install -d -o avalanche -g avalanche -m 750 "${DATA_DIR}/configs" "${DATA_DIR}/configs/chains" "${CHAIN_DIR}"
install -o avalanche -g avalanche -m 644 "${L1_CHAIN_CONFIG}" "${CHAIN_DIR}/config.json"
if [ -f "${L1_UPGRADE}" ]; then
  install -o avalanche -g avalanche -m 644 "${L1_UPGRADE}" "${CHAIN_DIR}/upgrade.json"
fi
install -m 644 "${UNIT}" "/etc/systemd/system/${SERVICE}.service"

# The firewall. A host without it gets nftables.conf whole; on a host that has it, the file is never
# reloaded: a reload flushes the whole ruleset, and with it the rules other services added (Docker's
# tables, ports opened for a VPN). Only this node's staking port is added, to the file and live.
# A host has the firewall once its file lets SSH in (Debian's stock file has an empty table).
if ! grep -q "tcp dport 22 accept" /etc/nftables.conf 2>/dev/null; then
  install -m 755 "${HERE}/nftables.conf" /etc/nftables.conf
  nft -c -f /etc/nftables.conf
  systemctl enable --now nftables
  nft -f /etc/nftables.conf
fi
if ! grep -q "tcp dport ${STAKING_PORT} accept" /etc/nftables.conf; then
  sed -i "/tcp dport 22 accept/a\\    tcp dport ${STAKING_PORT} accept # Avalanche ${NETWORK} p2p" /etc/nftables.conf
  nft -c -f /etc/nftables.conf
fi
if ! nft list chain inet filter input | grep -q "tcp dport ${STAKING_PORT} accept"; then
  nft add rule inet filter input tcp dport "${STAKING_PORT}" accept
fi

systemctl daemon-reload
systemctl enable "${SERVICE}"
systemctl restart "${SERVICE}"
"${TARGET}/avalanchego" --version
