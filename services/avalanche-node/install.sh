#!/usr/bin/env bash
# Installs (or upgrades) AvalancheGo and the Subnet-EVM plugin as a systemd service.
# Idempotent: rerun after changing the pinned version below. Run as root on Debian 13.
set -euo pipefail

AVALANCHEGO_VERSION="v1.15.1"
AVALANCHEGO_SHA256="6d57678a0fb9cc90eea31aa86bfdf582f79ec5187162672123c0fbd0d473ff78"
SUBNET_EVM_SHA256="984090867966368608fa2a46353030352d0e8d0b20029c022a3755b991432e21"
# Subnet-EVM's default VM ID: the plugin file must carry this name.
SUBNET_EVM_VM_ID="srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy"

HERE="$(cd "$(dirname "$0")" && pwd)"
RELEASES="https://github.com/ava-labs/avalanchego/releases/download/${AVALANCHEGO_VERSION}"
TARGET="/opt/avalanchego/${AVALANCHEGO_VERSION}"

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

id avalanche >/dev/null 2>&1 || useradd --system --home-dir /var/lib/avalanchego --shell /usr/sbin/nologin avalanche
install -d -o avalanche -g avalanche -m 750 /var/lib/avalanchego /var/lib/avalanchego/plugins
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
install -o avalanche -g avalanche -m 755 "${TARGET}/subnet-evm" "/var/lib/avalanchego/plugins/${SUBNET_EVM_VM_ID}"

install -m 644 "${HERE}/node.json" /etc/avalanchego/node.json
install -m 644 "${HERE}/avalanchego.service" /etc/systemd/system/avalanchego.service
install -m 755 "${HERE}/nftables.conf" /etc/nftables.conf
nft -c -f /etc/nftables.conf
systemctl enable --now nftables
systemctl reload nftables || nft -f /etc/nftables.conf

systemctl daemon-reload
systemctl enable avalanchego
systemctl restart avalanchego
"${TARGET}/avalanchego" --version
