#!/usr/bin/env bash
# Installs (or upgrades) Ava Labs' signature-aggregator and ICM relayer next to the node. Idempotent;
# run as root on the validator host after ../install.sh.
#   - signature-aggregator: asks Primary Network validators to sign P-Chain messages (the C-Chain's
#     ValidatorManager accepts no others) and the L1's validators to sign the L1's.
#   - icm-relayer: carries Teleporter messages between the C-Chain and the L1 (ICTT rides on them).
#     Its key pays gas on both sides and lives only in /etc/icm/relayer.env as ACCOUNT_PRIVATE_KEY.
set -euo pipefail

AGGREGATOR_VERSION="0.6.0"
AGGREGATOR_SHA256="7be57376f7ac99b26a40469e4f526569e6a2f682c8e59e39fe4da25df0509513"
RELAYER_VERSION="1.8.3"
RELAYER_SHA256="ccd5ffc4ae99975eaec66e7cc4a1c63365229ee492e602e43fa399799339688b"

HERE="$(cd "$(dirname "$0")" && pwd)"
RELEASES="https://github.com/ava-labs/icm-services/releases/download"

id icm >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin icm
install -d -m 755 /etc/icm

# install_release <binary> <version> <sha256>: /opt/icm/<binary>-<version>, linked as /opt/icm/<binary>
install_release() {
  local binary="$1" version="$2" sha="$3"
  local target="/opt/icm/${binary}-${version}" name="${binary}_${version}_linux_amd64.tar.gz"
  if [ ! -x "${target}/${binary}" ]; then
    curl -fsSL -o "/tmp/${name}" "${RELEASES}/${binary}-v${version}/${name}"
    echo "${sha}  /tmp/${name}" | sha256sum -c --quiet -
    local work
    work="$(mktemp -d)"
    tar -xzf "/tmp/${name}" -C "${work}"
    install -d "${target}"
    install -m 755 "$(find "${work}" -type f -name "${binary}" | head -1)" "${target}/${binary}"
    rm -rf "${work}" "/tmp/${name}"
  fi
  ln -sfn "${target}" "/opt/icm/${binary}"
}

install_release signature-aggregator "${AGGREGATOR_VERSION}" "${AGGREGATOR_SHA256}"
install_release icm-relayer "${RELAYER_VERSION}" "${RELAYER_SHA256}"

if [ ! -s /etc/icm/relayer.env ]; then
  echo "missing /etc/icm/relayer.env (ACCOUNT_PRIVATE_KEY=0x…, the relayer's own key, funded on both chains)" >&2
  exit 1
fi
chown root:icm /etc/icm/relayer.env
chmod 640 /etc/icm/relayer.env

for unit in signature-aggregator icm-relayer; do
  install -m 644 "${HERE}/${unit}.json" "/etc/icm/${unit}.json"
  install -m 644 "${HERE}/${unit}.service" "/etc/systemd/system/${unit}.service"
done
systemctl daemon-reload
for unit in signature-aggregator icm-relayer; do
  systemctl enable "${unit}"
  systemctl restart "${unit}"
done
/opt/icm/signature-aggregator/signature-aggregator --version
/opt/icm/icm-relayer/icm-relayer --version
