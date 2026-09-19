package nativebridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
)

type memoryState struct {
	pins  map[Address]Word
	slots map[Address]map[Word]Word
	reads int
	fail  bool
}

func (s *memoryState) CodeHash(a Address) (Word, error) {
	if s.fail {
		return Word{}, errors.New("state failure")
	}
	return s.pins[a], nil
}
func (s *memoryState) Storage(a Address, w Word) (Word, error) {
	s.reads++
	if s.fail {
		return Word{}, errors.New("storage failure")
	}
	v, ok := s.slots[a][w]
	if !ok {
		return Word{}, errors.New("missing slot")
	}
	return v, nil
}
func addr(n byte) Address { return Address{19: n} }
func word(n byte) Word    { return Word{31: n} }
func pack(fields ...[3]int64) Word {
	out := new(big.Int)
	for _, f := range fields {
		n := big.NewInt(f[0])
		if f[0] < 0 {
			n.Add(n, new(big.Int).Lsh(big.NewInt(1), uint(f[2])))
		}
		out.Or(out, new(big.Int).Lsh(n, uint(f[1])))
	}
	var result Word
	out.FillBytes(result[:])
	return result
}
func configuration(kind string) Config {
	fields := []Field{}
	for name, shape := range shapes[kind] {
		shape.Name = name
		shape.Slot = word(byte(len(fields))).String()
		fields = append(fields, shape)
	}
	if kind == "v2" {
		fields = []Field{{"reserve0", word(8).String(), 0, 112, "uint"}, {"reserve1", word(8).String(), 112, 112, "uint"}}
	}
	return Config{Schema: 1, ChainID: 4663, NitroRevision: Revision, SocketPath: "/unused/native.sock", Relayer: addr(9).String(), ReceiptFeeModel: FeeModel, CodeHashes: map[string]string{addr(1).String(): word(3).String()}, Pools: []Pool{{ID: "pool", Kind: kind, Address: addr(1).String(), Fields: fields}}}
}
func manifest(t *testing.T, c Config) *Manifest {
	t.Helper()
	raw, e := json.Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	m, e := LoadManifest(raw)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func stateFor(m *Manifest) *memoryState {
	s := &memoryState{pins: map[Address]Word{}, slots: map[Address]map[Word]Word{}}
	for a, h := range m.pins {
		s.pins[a] = h
		s.slots[a] = map[Word]Word{}
	}
	for _, p := range m.pools {
		for _, f := range p.fields {
			s.slots[p.address][f.slot] = Word{}
		}
	}
	return s
}
func head(n byte) Head {
	return Head{uint64(n) + 100, uint64(n), 1000 + uint64(n), word(n), word(n - 1), word(n + 10)}
}
func TestPackedReserves(t *testing.T) {
	m := manifest(t, configuration("v2"))
	s := stateFor(m)
	s.slots[addr(1)][word(8)] = pack([3]int64{123456, 0, 112}, [3]int64{654321, 112, 112}, [3]int64{99, 224, 32})
	b, e := m.Capture(head(10), s, nil)
	if e != nil {
		t.Fatal(e)
	}
	var f Frame
	_ = json.Unmarshal(b.Snapshot, &f)
	if f.Updates[0]["reserve0"] != "123456" || f.Updates[0]["reserve1"] != "654321" || s.reads != 1 {
		t.Fatalf("bad decode/cache %+v %d", f, s.reads)
	}
	if f.ExecutionSource != m.Source() || f.StateRoot != head(10).StateRoot.String() || f.FeedBlockHash != f.BlockHash {
		t.Fatal("provenance")
	}
	if string(b.Block) == string(b.Snapshot) {
		t.Fatal("frame type not distinct")
	}
}
func TestSignedTickAndBool(t *testing.T) {
	m := manifest(t, configuration("v3"))
	s := stateFor(m)
	for _, f := range m.pools[0].fields {
		if f.Name == "tick" {
			s.slots[addr(1)][f.slot] = pack([3]int64{-456, 0, 24})
		}
		if f.Name == "unlocked" {
			s.slots[addr(1)][f.slot] = word(1)
		}
	}
	b, e := m.Capture(head(10), s, nil)
	if e != nil {
		t.Fatal(e)
	}
	var f Frame
	_ = json.Unmarshal(b.Block, &f)
	if f.Updates[0]["tick"] != float64(-456) || f.Updates[0]["unlocked"] != true {
		t.Fatal(f.Updates)
	}
	for _, field := range m.pools[0].fields {
		if field.Name == "unlocked" {
			s.slots[addr(1)][field.slot] = word(2)
		}
	}
	if _, e = m.Capture(head(11), s, nil); e == nil {
		t.Fatal("invalid bool accepted")
	}
}
func TestUint112Maximum(t *testing.T) {
	m := manifest(t, configuration("v2"))
	s := stateFor(m)
	var full Word
	for i := range full {
		full[i] = 255
	}
	s.slots[addr(1)][word(8)] = full
	b, e := m.Capture(head(10), s, nil)
	if e != nil {
		t.Fatal(e)
	}
	var f Frame
	_ = json.Unmarshal(b.Block, &f)
	want := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 112), big.NewInt(1)).String()
	if f.Updates[0]["reserve0"] != want || f.Updates[0]["reserve1"] != want {
		t.Fatal(f.Updates)
	}
}
func TestV4FieldPacking(t *testing.T) {
	c := configuration("v4")
	c.Pools[0].PoolKeyHash = word(99).String()
	c.Pools[0].Fields = []Field{{"sqrtPriceX96", word(5).String(), 0, 160, "uint"}, {"tick", word(5).String(), 160, 24, "int"}, {"protocolFee", word(5).String(), 184, 24, "uint"}, {"lpFee", word(5).String(), 208, 24, "uint"}, {"liquidity", word(8).String(), 0, 128, "uint"}}
	m := manifest(t, c)
	s := stateFor(m)
	s.slots[addr(1)][word(5)] = pack([3]int64{123, 0, 160}, [3]int64{-2, 160, 24}, [3]int64{100, 184, 24}, [3]int64{3000, 208, 24})
	s.slots[addr(1)][word(8)] = word(50)
	b, e := m.Capture(head(10), s, nil)
	if e != nil {
		t.Fatal(e)
	}
	var f Frame
	_ = json.Unmarshal(b.Block, &f)
	u := f.Updates[0]
	if u["sqrtPriceX96"] != "123" || u["tick"] != float64(-2) || u["protocolFee"] != "100" || u["lpFee"] != "3000" || u["liquidity"] != "50" {
		t.Fatal(u)
	}
	if s.reads != 2 {
		t.Fatal("packed slots not cached")
	}
}
func TestAtomicCaptureRejectsCodeOrStorageChanges(t *testing.T) {
	c := configuration("v2")
	c.Guards = []Guard{{addr(1).String(), word(9).String(), word(7).String()}}
	m := manifest(t, c)
	s := stateFor(m)
	s.slots[addr(1)][word(9)] = word(7)
	if _, e := m.Capture(head(10), s, nil); e != nil {
		t.Fatal(e)
	}
	s.slots[addr(1)][word(9)] = word(8)
	if b, e := m.Capture(head(10), s, nil); b != nil || e == nil {
		t.Fatal("changed guard accepted")
	}
	s.slots[addr(1)][word(9)] = word(7)
	s.pins[addr(1)] = word(4)
	if b, e := m.Capture(head(10), s, nil); b != nil || e == nil {
		t.Fatal("changed code accepted")
	}
	s.fail = true
	if b, e := m.Capture(head(10), s, nil); b != nil || e == nil {
		t.Fatal("read failure accepted")
	}
}
func TestCaptureDoesNotRetainMutableStorage(t *testing.T) {
	m := manifest(t, configuration("v2"))
	s := stateFor(m)
	b, e := m.Capture(head(10), s, nil)
	if e != nil {
		t.Fatal(e)
	}
	original := string(b.Block)
	s.slots[addr(1)][word(8)] = word(100)
	if string(b.Block) != original {
		t.Fatal("mutable state escaped")
	}
}
func TestManifestInvalidCases(t *testing.T) {
	cases := map[string]func(*Config){
		"chain": func(c *Config) { c.ChainID = 1 }, "revision": func(c *Config) { c.NitroRevision = "main" }, "model": func(c *Config) { c.Pools[0].Kind = "curve" },
		"missing pin": func(c *Config) { c.CodeHashes = map[string]string{} }, "zero pin": func(c *Config) { c.CodeHashes[addr(1).String()] = (Word{}).String() },
		"missing field": func(c *Config) { c.Pools[0].Fields = c.Pools[0].Fields[:1] }, "extra field": func(c *Config) { c.Pools[0].Fields = append(c.Pools[0].Fields, c.Pools[0].Fields[0]) },
		"overlap": func(c *Config) { c.Pools[0].Fields[1].Offset = 0 }, "overrun": func(c *Config) { c.Pools[0].Fields[1].Offset = 255 },
		"field type": func(c *Config) { c.Pools[0].Fields[0].Type = "int" }, "field width": func(c *Config) { c.Pools[0].Fields[0].Width = 111 },
		"alias name": func(c *Config) { c.Pools = append(c.Pools, c.Pools[0]) }, "slot": func(c *Config) { c.Pools[0].Fields[0].Slot = "0x0" },
		"relayer": func(c *Config) { c.Relayer = (Address{}).String() }, "fee": func(c *Config) { c.ReceiptFeeModel = "unknown" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			c := configuration("v2")
			mutate(&c)
			raw, _ := json.Marshal(c)
			if _, e := LoadManifest(raw); e == nil {
				t.Fatal("accepted")
			}
		})
	}
	for _, raw := range []string{`{}`, `{} {}`, strings.Repeat(" ", MaxFrameBytes+1)} {
		if _, e := LoadManifest([]byte(raw)); e == nil {
			t.Fatal("invalid JSON accepted")
		}
	}
}
func TestWorstCaseWethCosts(t *testing.T) {
	c := configuration("v2")
	c.GasBudget = &GasBudget{addr(1).String(), "850000", "500000000", 2500, true}
	m := manifest(t, c)
	b, e := m.Capture(head(10), stateFor(m), nil)
	if e != nil {
		t.Fatal(e)
	}
	var f CostsFrame
	_ = json.Unmarshal(b.Costs, &f)
	v := f.Entries[0]
	if v.SuccessGasWei != "425000000000000" || v.RevertGasWei != v.SuccessGasWei || v.ValidUntilBlock != "11" || v.Numerator != "1" || v.Denominator != "1" {
		t.Fatal(v)
	}
	c.GasBudget.WrappedNativeReviewed = false
	raw, _ := json.Marshal(c)
	if _, e := LoadManifest(raw); e == nil {
		t.Fatal("unreviewed conversion accepted")
	}
}
func validReceipt() Receipt {
	h := head(10)
	return Receipt{TxHash: word(90).String(), BlockNumber: "10", BlockHash: h.Hash.String(), Nonce: "0", Status: 1, FeeModel: FeeModel, GasUsed: "50000", EffectiveGasPrice: "10", Logs: []Log{}}
}
func TestReceiptBindingAndErrors(t *testing.T) {
	m := manifest(t, configuration("v2"))
	s := stateFor(m)
	receipt := validReceipt()
	b, e := m.Capture(head(10), s, []Receipt{receipt})
	if e != nil {
		t.Fatal(e)
	}
	var parsed Receipt
	_ = json.Unmarshal(b.Receipts[0], &parsed)
	if parsed.Type != "receipt" || parsed.ExecutionSource != m.Source() {
		t.Fatal(parsed)
	}
	cases := []func(*Receipt){func(r *Receipt) { r.BlockNumber = "11" }, func(r *Receipt) { r.BlockHash = word(12).String() }, func(r *Receipt) { r.Status = 2 }, func(r *Receipt) { r.GasUsed = "0" }, func(r *Receipt) { r.EffectiveGasPrice = "-1" }, func(r *Receipt) { r.Nonce = "-1" }, func(r *Receipt) { r.FeeModel = "guess" }, func(r *Receipt) { r.Logs = []Log{{addr(1).String(), []string{}, "0x", true}} }, func(r *Receipt) { r.Logs = []Log{{addr(1).String(), []string{}, "0xxx", false}} }}
	for i, change := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			r := validReceipt()
			change(&r)
			if b, e := m.Capture(head(10), s, []Receipt{r}); b != nil || e == nil {
				t.Fatal("malformed receipt accepted")
			}
		})
	}
	if _, e := m.Capture(head(10), s, []Receipt{receipt, receipt}); e == nil {
		t.Fatal("duplicate receipt accepted")
	}
}
