// SYNTHETIC FIXTURE ONLY. No node, RPC, keys, signing or live execution.
package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"

	bridge "robinhood-native-exporter"
)

type fixtureState struct {
	values map[bridge.Address]bridge.Word
}

func (s fixtureState) CodeHash(a bridge.Address) (bridge.Word, error) {
	return bridge.Word{31: 77}, nil
}
func (s fixtureState) Storage(a bridge.Address, w bridge.Word) (bridge.Word, error) {
	if w != (bridge.Word{31: 8}) {
		return bridge.Word{}, fmt.Errorf("unknown synthetic slot")
	}
	v, ok := s.values[a]
	if !ok {
		return v, fmt.Errorf("unknown synthetic address")
	}
	return v, nil
}
func packed(a, b int64) bridge.Word {
	n := new(big.Int).Or(big.NewInt(a), new(big.Int).Lsh(big.NewInt(b), 112))
	var w bridge.Word
	n.FillBytes(w[:])
	return w
}
func main() {
	a, b := bridge.Address{19: 10}, bridge.Address{19: 11}
	pin := bridge.Word{31: 77}
	slot := bridge.Word{31: 8}
	config := bridge.Config{Schema: 1, ChainID: 4663, NitroRevision: bridge.Revision, SocketPath: "/synthetic/never-live.sock", Relayer: (bridge.Address{19: 99}).String(), ReceiptFeeModel: bridge.FeeModel, CodeHashes: map[string]string{a.String(): pin.String(), b.String(): pin.String()}}
	for i, address := range []bridge.Address{a, b} {
		id := []string{"demo-a", "demo-b"}[i]
		config.Pools = append(config.Pools, bridge.Pool{ID: id, Kind: "v2", Address: address.String(), Fields: []bridge.Field{{Name: "reserve0", Slot: slot.String(), Width: 112, Type: "uint"}, {Name: "reserve1", Slot: slot.String(), Offset: 112, Width: 112, Type: "uint"}}})
	}
	raw, err := json.Marshal(config)
	if err != nil {
		panic(err)
	}
	manifest, err := bridge.LoadManifest(raw)
	if err != nil {
		panic(err)
	}
	state := fixtureState{map[bridge.Address]bridge.Word{a: packed(1000000, 2000000), b: packed(1000000, 1000000)}}
	for n := uint64(100); n <= 101; n++ {
		if n == 101 {
			state.values[a] = packed(1000000, 2010000)
		}
		head := bridge.Head{Sequence: n, Number: n, Timestamp: 1700000000 + n, Hash: bridge.Word{31: byte(n)}, ParentHash: bridge.Word{31: byte(n - 1)}, StateRoot: bridge.Word{31: byte(n + 10)}}
		batch, err := manifest.Capture(head, state, nil)
		if err != nil {
			panic(err)
		}
		out := batch.Block
		if n == 100 {
			out = batch.Snapshot
		}
		if _, err = os.Stdout.Write(out); err != nil {
			panic(err)
		}
	}
}
