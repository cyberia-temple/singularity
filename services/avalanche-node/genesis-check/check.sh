#!/usr/bin/env bash
# Verifies a Subnet-EVM genesis the way the node will when the chain is created (parse, network
# upgrades, precompile rules, commit), with the AvalancheGo release pinned in ../install.sh. Run it
# before every CreateChainTx: the P-Chain accepts any bytes, and a chain whose genesis the VM refuses
# can only be abandoned.
#
#   services/avalanche-node/genesis-check/check.sh <genesis.json> [fuji|mainnet]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GENESIS="$(realpath "$1")"
VERSION="$(sed -n 's/^AVALANCHEGO_VERSION="\(.*\)"/\1/p' "${HERE}/../install.sh")"
CACHE="${XDG_CACHE_HOME:-${HOME}/.cache}/cyberia-genesis-check/${VERSION}"
SOURCE="${CACHE}/avalanchego"

if [ ! -d "${SOURCE}" ]; then
  git -c advice.detachedHead=false clone -q --filter=blob:none --depth 1 --branch "${VERSION}" https://github.com/ava-labs/avalanchego.git "${SOURCE}"
fi
if [ ! -x "${CACHE}/check" ] || [ "${HERE}/main.go" -nt "${CACHE}/check" ]; then
  work="${CACHE}/build"
  mkdir -p "${work}"
  cp "${HERE}/main.go" "${work}/main.go"
  cat > "${work}/go.mod" <<MOD
module genesischeck

go $(sed -n 's/^go //p' "${SOURCE}/go.mod")

require github.com/ava-labs/avalanchego/graft/subnet-evm v0.0.0

replace github.com/ava-labs/avalanchego => ${SOURCE}
replace github.com/ava-labs/avalanchego/graft/subnet-evm => ${SOURCE}/graft/subnet-evm
replace github.com/ava-labs/avalanchego/graft/evm => ${SOURCE}/graft/evm
replace github.com/ava-labs/avalanchego/graft/coreth => ${SOURCE}/graft/coreth
MOD
  (cd "${work}" && GOTOOLCHAIN=auto GOFLAGS=-mod=mod go mod tidy >/dev/null && GOTOOLCHAIN=auto go build -o "${CACHE}/check" .)
fi
"${CACHE}/check" "${GENESIS}" "${2:-fuji}"
