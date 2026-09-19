// SYNTHETIC TEST FIXTURE. Never connects to a node, wallet, RPC or live socket.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	bridge "robinhood-native-exporter"
)

type state struct {
	slots    map[bridge.Address]map[bridge.Word]bridge.Word
	mappings map[[2]bridge.Word]bridge.Word
}

func (s state) CodeHash(a bridge.Address) (bridge.Word, error) { return bridge.Word{31: 77}, nil }
func (s state) Storage(a bridge.Address, w bridge.Word) (bridge.Word, error) {
	v, ok := s.slots[a][w]
	if !ok {
		return v, fmt.Errorf("missing synthetic slot")
	}
	return v, nil
}
func (s state) MappingSlot(k, b bridge.Word) bridge.Word { return s.mappings[[2]bridge.Word{k, b}] }
func parse(s string) bridge.Word {
	w, e := bridge.ParseWord(s)
	if e != nil {
		panic(e)
	}
	return w
}
func main() {
	if len(os.Args) != 2 {
		panic("synthetic fixture path required")
	}
	raw, e := os.ReadFile(os.Args[1])
	if e != nil {
		panic(e)
	}
	var f struct {
		Synthetic bool                                    `json:"synthetic"`
		Config    bridge.Config                           `json:"exporterConfig"`
		Slots     []struct{ Address, Slot, Value string } `json:"slots"`
		Mappings  []struct{ Key, Base, Slot string }      `json:"mappings"`
	}
	if e = json.Unmarshal(raw, &f); e != nil || !f.Synthetic {
		panic("invalid synthetic fixture")
	}
	raw, e = json.Marshal(f.Config)
	if e != nil {
		panic(e)
	}
	m, e := bridge.LoadManifest(raw)
	if e != nil {
		panic(e)
	}
	s := state{map[bridge.Address]map[bridge.Word]bridge.Word{}, map[[2]bridge.Word]bridge.Word{}}
	for _, v := range f.Slots {
		a, e := bridge.ParseAddress(v.Address)
		if e != nil {
			panic(e)
		}
		if s.slots[a] == nil {
			s.slots[a] = map[bridge.Word]bridge.Word{}
		}
		s.slots[a][parse(v.Slot)] = parse(v.Value)
	}
	for _, v := range f.Mappings {
		s.mappings[[2]bridge.Word{parse(v.Key), parse(v.Base)}] = parse(v.Slot)
	}
	for n := uint64(100); n <= 101; n++ {
		h := bridge.Head{Sequence: n, Number: n, Timestamp: 1700000000 + n, Hash: bridge.Word{31: byte(n)}, ParentHash: bridge.Word{31: byte(n - 1)}, StateRoot: bridge.Word{31: byte(n + 10)}}
		b, e := m.Capture(h, s, nil)
		if e != nil {
			panic(e)
		}
		out := b.Block
		if n == 100 {
			out = b.Snapshot
		}
		if _, e = os.Stdout.Write(out); e != nil {
			panic(e)
		}
	}
}
