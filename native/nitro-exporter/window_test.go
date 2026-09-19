package nativebridge

import (
	"encoding/json"
	"math/big"
	"os"
	"testing"
)

// Hashing is supplied by the Geth adapter in production. Unit tests spy on full
// ABI-word keys using known mappings, rather than inventing a SHA3 substitute.
type mappedMemory struct {
	*memoryState
	mappings map[[2]Word]Word
}

func (m *mappedMemory) MappingSlot(k, b Word) Word { return m.mappings[[2]Word{k, b}] }
func windowFixture(t *testing.T) (*Manifest, *mappedMemory, Config) {
	c := configuration("v4")
	p := &c.Pools[0]
	p.PoolKeyHash = word(99).String()
	p.TickWindow = &TickWindowConfig{60, -1, 0}
	p.Fields = []Field{{"sqrtPriceX96", word(5).String(), 0, 160, "uint"}, {"tick", word(5).String(), 160, 24, "int"}, {"protocolFee", word(5).String(), 184, 24, "uint"}, {"lpFee", word(5).String(), 208, 24, "uint"}, {"liquidity", word(8).String(), 0, 128, "uint"}}
	m := manifest(t, c)
	s := &mappedMemory{stateFor(m), map[[2]Word]Word{}}
	s.mappings[[2]Word{word(99), word(6)}] = word(5)
	s.mappings[[2]Word{signedWord(-1), word(10)}] = word(100)
	s.mappings[[2]Word{signedWord(0), word(10)}] = word(101)
	s.mappings[[2]Word{signedWord(-60), word(9)}] = word(102)
	s.mappings[[2]Word{signedWord(60), word(9)}] = word(103)
	values := s.slots[addr(1)]
	values[word(5)] = pack([3]int64{1, 96, 1}, [3]int64{600, 208, 24})
	values[word(8)] = unsignedWord(1000)
	values[word(100)] = pack([3]int64{1, 255, 1})
	values[word(101)] = word(2)
	values[word(102)] = pack([3]int64{1000, 0, 128}, [3]int64{1000, 128, 128})
	values[word(103)] = pack([3]int64{1000, 0, 128}, [3]int64{-1000, 128, 128})
	return m, s, c
}
func TestV4WindowCapture(t *testing.T) {
	m, s, _ := windowFixture(t)
	batch, e := m.Capture(head(10), s, nil)
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Updates []struct {
			Window TickWindowState `json:"tickWindow"`
		} `json:"updates"`
	}
	if e = json.Unmarshal(batch.Block, &f); e != nil {
		t.Fatal(e)
	}
	w := f.Updates[0].Window
	if len(w.Words) != 2 || len(w.Ticks) != 2 || w.Ticks[0].Tick != -60 || w.Ticks[1].Net != "-1000" || s.reads != 6 {
		t.Fatalf("bad window/cache %+v reads=%d", w, s.reads)
	}
	if signedWord(-1) != (Word{255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255}) {
		t.Fatal("negative key is not sign extended")
	}
}
func TestV4WindowRequiresMappingReader(t *testing.T) {
	m, s, _ := windowFixture(t)
	if _, e := m.Capture(head(10), s.memoryState, nil); e == nil {
		t.Fatal("unavailable hasher accepted")
	}
}
func TestV4WindowRejectsPoolBaseMismatch(t *testing.T) {
	m, s, _ := windowFixture(t)
	s.mappings[[2]Word{word(99), word(6)}] = word(6)
	if _, e := m.Capture(head(10), s, nil); e == nil {
		t.Fatal("wrong pool base accepted")
	}
}
func TestV4WindowMissingAndInconsistentState(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*mappedMemory)
	}{
		{"missing word", func(s *mappedMemory) { delete(s.slots[addr(1)], word(100)) }},
		{"missing tick", func(s *mappedMemory) { delete(s.slots[addr(1)], word(103)) }},
		{"unread initialized tick", func(s *mappedMemory) { s.slots[addr(1)][word(101)] = word(4) }},
		{"zero gross", func(s *mappedMemory) { s.slots[addr(1)][word(103)] = word(0) }},
		{"net exceeds gross", func(s *mappedMemory) {
			s.slots[addr(1)][word(103)] = pack([3]int64{10, 0, 128}, [3]int64{-20, 128, 128})
		}},
		{"wrong parity", func(s *mappedMemory) {
			s.slots[addr(1)][word(103)] = pack([3]int64{11, 0, 128}, [3]int64{-10, 128, 128})
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, s, _ := windowFixture(t)
			c.mutate(s)
			if _, e := m.Capture(head(10), s, nil); e == nil {
				t.Fatal("bad state accepted")
			}
		})
	}
}
func TestV4WindowConfigBoundsAndLayout(t *testing.T) {
	changes := []func(*Config){
		func(c *Config) { c.Pools[0].TickWindow.TickSpacing = 0 }, func(c *Config) { c.Pools[0].TickWindow.TickSpacing = 32768 },
		func(c *Config) { c.Pools[0].TickWindow.MinWord = -32769 }, func(c *Config) { c.Pools[0].TickWindow.MaxWord = 32768 },
		func(c *Config) { c.Pools[0].TickWindow.MaxWord = 8 }, func(c *Config) { c.Pools[0].TickWindow.MaxWord = -2 },
		func(c *Config) { c.Pools[0].Fields[0].Slot = word(17).String() }, func(c *Config) { c.Pools[0].Fields[4].Slot = word(9).String() },
	}
	for i, change := range changes {
		_, _, c := windowFixture(t)
		change(&c)
		raw, _ := json.Marshal(c)
		if _, e := LoadManifest(raw); e == nil {
			t.Fatalf("bad configuration %d accepted", i)
		}
	}
}
func TestV4WindowAllObservedWordsAreZero(t *testing.T) {
	raw, e := os.ReadFile("../../test/fixtures/v4-bitmaps-67237585.json")
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Pools []struct {
			PoolID  string `json:"poolId"`
			Spacing int32  `json:"tickSpacing"`
			Min     int32  `json:"minWord"`
			Max     int32  `json:"maxWord"`
			Base    string `json:"poolStateSlot"`
			Bitmaps []struct {
				Position int32  `json:"wordPosition"`
				Slot     string `json:"slot"`
				Result   string `json:"result"`
			} `json:"bitmaps"`
		} `json:"pools"`
	}
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	parse := func(value string) Word {
		t.Helper()
		w, err := ParseWord(value)
		if err != nil {
			t.Fatal(err)
		}
		return w
	}
	for _, p := range f.Pools {
		base := parse(p.Base)
		key := parse(p.PoolID)
		liq, err := addSlot(base, 3)
		if err != nil {
			t.Fatal(err)
		}
		bitmapBase, err := addSlot(base, 5)
		if err != nil {
			t.Fatal(err)
		}
		_, _, c := windowFixture(t)
		c.Pools[0].PoolKeyHash = p.PoolID
		c.Pools[0].TickWindow = &TickWindowConfig{p.Spacing, p.Min, p.Max}
		for i := range c.Pools[0].Fields {
			c.Pools[0].Fields[i].Slot = base.String()
			if c.Pools[0].Fields[i].Name == "liquidity" {
				c.Pools[0].Fields[i].Slot = liq.String()
			}
		}
		m := manifest(t, c)
		s := &mappedMemory{stateFor(m), map[[2]Word]Word{}}
		s.mappings[[2]Word{key, word(6)}] = base
		for _, b := range p.Bitmaps {
			slot := parse(b.Slot)
			value := parse(b.Result)
			s.mappings[[2]Word{signedWord(int64(b.Position)), bitmapBase}] = slot
			s.slots[addr(1)][slot] = value
		}
		out, e := captureWindow(m.pools[0], s, s.Storage)
		if e != nil {
			t.Fatal(e)
		}
		if len(out.Ticks) != 0 || len(out.Words) != len(p.Bitmaps) {
			t.Fatal("captured zero coverage did not decode")
		}
		legalMin := -(887272 / int64(p.Spacing))
		legalMax := 887272 / int64(p.Spacing)
		minWord := new(big.Int).Rsh(big.NewInt(legalMin), 8).Int64()
		if int64(p.Min) != minWord || int64(p.Max) != legalMax/256 {
			t.Fatal("window omits legal ticks")
		}
	}
}
