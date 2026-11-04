// Verifies a Subnet-EVM genesis the way the VM does on chain creation (parseGenesis + Commit), for Fuji or mainnet.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/ava-labs/avalanchego/graft/subnet-evm/core"
	"github.com/ava-labs/avalanchego/graft/subnet-evm/params"
	"github.com/ava-labs/avalanchego/graft/subnet-evm/params/extras"
	"github.com/ava-labs/avalanchego/graft/subnet-evm/plugin/evm"
	"github.com/ava-labs/avalanchego/snow"
	"github.com/ava-labs/avalanchego/upgrade"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/libevm/core/rawdb"
	"github.com/ava-labs/libevm/triedb"
)

func main() {
	evm.RegisterAllLibEVMExtras()
	networkID := constants.FujiID
	if len(os.Args) > 2 && os.Args[2] == "mainnet" {
		networkID = constants.MainnetID
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	g := new(core.Genesis)
	if err := json.Unmarshal(raw, g); err != nil {
		fmt.Println("parse:", err)
		os.Exit(1)
	}
	ups := upgrade.GetConfig(networkID)
	extra := params.GetExtra(g.Config)
	extra.AvalancheContext = extras.AvalancheContext{SnowCtx: &snow.Context{NetworkID: networkID, NetworkUpgrades: ups}}
	extra.SetDefaults(ups)
	if err := g.Verify(); err != nil {
		fmt.Println("verify:", err)
		os.Exit(1)
	}
	db := rawdb.NewMemoryDatabase()
	block, err := g.Commit(db, triedb.NewDatabase(db, triedb.HashDefaults))
	if err != nil {
		fmt.Println("commit:", err)
		os.Exit(1)
	}
	fmt.Printf("ok: network %d, genesis block %s, state root %s, %d alloc entries\n", networkID, block.Hash(), block.Root(), len(g.Alloc))
}
