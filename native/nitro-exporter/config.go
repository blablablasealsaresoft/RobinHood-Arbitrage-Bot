// Package nativebridge exports reviewed storage from an already-executed,
// canonical local Nitro state. It does not replace Nitro consensus or verify
// sequencer signatures independently. Only the standard library is used.
package nativebridge

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"
)

const Revision = "a618155919315241665356fe60f3cd00d66d5e46"
const FeeModel = "gasUsed-times-effectiveGasPrice-inclusive"
const MaxFrameBytes = 1 << 20

type Address [20]byte
type Word [32]byte

func (a Address) String() string { return "0x" + hex.EncodeToString(a[:]) }
func (w Word) String() string    { return "0x" + hex.EncodeToString(w[:]) }
func parseHex(s string, n int) ([]byte, error) {
	if len(s) != 2+2*n || !strings.HasPrefix(s, "0x") {
		return nil, errors.New("invalid fixed-width hex")
	}
	return hex.DecodeString(s[2:])
}
func ParseWord(s string) (Word, error) {
	var w Word
	b, e := parseHex(s, 32)
	copy(w[:], b)
	return w, e
}
func ParseAddress(s string) (Address, error) {
	var a Address
	b, e := parseHex(s, 20)
	copy(a[:], b)
	if a == (Address{}) {
		return a, errors.New("zero address")
	}
	return a, e
}
func positiveDecimal(s string) (*big.Int, error) {
	if s == "" {
		return nil, errors.New("empty integer")
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return nil, errors.New("non-decimal integer")
		}
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() <= 0 || v.BitLen() > 256 {
		return nil, errors.New("integer outside uint256 positive range")
	}
	return v, nil
}

type Field struct {
	Name   string `json:"name"`
	Slot   string `json:"slot"`
	Offset uint16 `json:"offset"`
	Width  uint16 `json:"width"`
	Type   string `json:"type"`
}
type Pool struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	Address     string  `json:"address"`
	Fields      []Field `json:"fields"`
	PoolKeyHash string  `json:"poolKeyHash,omitempty"`
}
type Guard struct {
	Address string `json:"address"`
	Slot    string `json:"slot"`
	Value   string `json:"value"`
}

// GasBudget refreshes a conservative WETH-only cost policy at each executed
// block. It is NOT a fee estimator or an oracle. Both success and failure are
// charged the maximum signed gas exposure. No non-WETH exchange rate is assumed.
type GasBudget struct {
	SettlementToken       string `json:"settlementToken"`
	GasLimit              string `json:"gasLimit"`
	MaxFeePerGas          string `json:"maxFeePerGas"`
	LoseRaceBps           uint16 `json:"loseRaceBps"`
	WrappedNativeReviewed bool   `json:"wrappedNativeReviewed"`
}
type Config struct {
	Schema          int               `json:"schema"`
	ChainID         uint64            `json:"chainId"`
	NitroRevision   string            `json:"nitroRevision"`
	SocketPath      string            `json:"socketPath"`
	Relayer         string            `json:"relayer"`
	ReceiptFeeModel string            `json:"receiptFeeModel"`
	CodeHashes      map[string]string `json:"codeHashes"`
	Guards          []Guard           `json:"guards"`
	Pools           []Pool            `json:"pools"`
	GasBudget       *GasBudget        `json:"gasBudget,omitempty"`
}
type compiledField struct {
	Field
	slot Word
}
type compiledPool struct {
	id, kind string
	address  Address
	fields   []compiledField
}
type compiledGuard struct {
	address     Address
	slot, value Word
}
type Source struct {
	Kind         string `json:"kind"`
	Revision     string `json:"revision"`
	ManifestHash string `json:"manifestHash"`
}
type Manifest struct {
	source      Source
	config      Config
	pins        map[Address]Word
	pools       []compiledPool
	guards      []compiledGuard
	relayer     Address
	budgetToken Address
	budgetWei   string
}

func (m *Manifest) Source() Source     { return m.source }
func (m *Manifest) SocketPath() string { return m.config.SocketPath }
func (m *Manifest) Relayer() Address   { return m.relayer }
func (m *Manifest) FeeModel() string   { return m.config.ReceiptFeeModel }

// Field shapes describe the existing native engine's exact return-value model.
// Slots themselves are explicit reviewed manifest inputs, not inferred from a
// venue name. Runtime code hashes and optional storage guards are checked on
// every capture; a matching name alone never establishes layout compatibility.
var shapes = map[string]map[string]Field{
	"v2": {"reserve0": {Width: 112, Type: "uint"}, "reserve1": {Width: 112, Type: "uint"}},
	"v3": {"sqrtPriceX96": {Width: 160, Type: "uint"}, "tick": {Width: 24, Type: "int"}, "liquidity": {Width: 128, Type: "uint"}, "observationIndex": {Width: 16, Type: "uint"}, "observationCardinality": {Width: 16, Type: "uint"}, "observationCardinalityNext": {Width: 16, Type: "uint"}, "feeProtocol": {Width: 8, Type: "uint"}, "unlocked": {Width: 8, Type: "bool"}},
	"v4": {"sqrtPriceX96": {Width: 160, Type: "uint"}, "tick": {Width: 24, Type: "int"}, "liquidity": {Width: 128, Type: "uint"}, "protocolFee": {Width: 24, Type: "uint"}, "lpFee": {Width: 24, Type: "uint"}},
}

func LoadManifest(raw []byte) (*Manifest, error) {
	if len(raw) == 0 || len(raw) > MaxFrameBytes {
		return nil, errors.New("manifest size")
	}
	var c Config
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&c); e != nil {
		return nil, e
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, errors.New("trailing manifest data")
	}
	if c.Schema != 1 || c.ChainID != 4663 || c.NitroRevision != Revision {
		return nil, errors.New("schema/chain/Nitro revision mismatch")
	}
	if c.ReceiptFeeModel != FeeModel {
		return nil, errors.New("explicit reviewed receipt fee model required")
	}
	if len(c.Pools) == 0 || len(c.Pools) > 128 || len(c.CodeHashes) > 1024 || len(c.Guards) > 512 {
		return nil, errors.New("manifest limits")
	}
	relayer, e := ParseAddress(c.Relayer)
	if e != nil {
		return nil, e
	}
	sum := sha256.Sum256(raw)
	m := &Manifest{source: Source{"nitro-in-process", Revision, "0x" + hex.EncodeToString(sum[:])}, config: c, pins: map[Address]Word{}, relayer: relayer}
	for a, h := range c.CodeHashes {
		addr, e := ParseAddress(a)
		if e != nil {
			return nil, e
		}
		w, e := ParseWord(h)
		if e != nil || w == (Word{}) {
			return nil, errors.New("invalid code pin")
		}
		if _, ok := m.pins[addr]; ok {
			return nil, errors.New("duplicate normalized code pin")
		}
		m.pins[addr] = w
	}
	seen := map[string]bool{}
	physical := map[string]bool{}
	for _, p := range c.Pools {
		expected, ok := shapes[p.Kind]
		if !ok || len(p.ID) == 0 || len(p.ID) > 128 || seen[p.ID] || len(p.Fields) != len(expected) {
			return nil, errors.New("unsupported/duplicate pool or field coverage")
		}
		seen[p.ID] = true
		a, e := ParseAddress(p.Address)
		if e != nil {
			return nil, e
		}
		if _, ok := m.pins[a]; !ok {
			return nil, errors.New("pool missing code pin")
		}
		identity := "pair:" + a.String()
		if p.Kind == "v4" {
			key, err := ParseWord(p.PoolKeyHash)
			if err != nil || key == (Word{}) {
				return nil, errors.New("v4 pool key hash required")
			}
			identity = "v4:" + a.String() + ":" + key.String()
		} else if p.PoolKeyHash != "" {
			return nil, errors.New("unexpected pool key")
		}
		if physical[identity] {
			return nil, errors.New("duplicate physical pool")
		}
		physical[identity] = true
		cp := compiledPool{id: p.ID, kind: p.Kind, address: a}
		names := map[string]bool{}
		used := map[Word]*big.Int{}
		for _, f := range p.Fields {
			shape, ok := expected[f.Name]
			if !ok || names[f.Name] || f.Width != shape.Width || f.Type != shape.Type || uint32(f.Offset)+uint32(f.Width) > 256 {
				return nil, fmt.Errorf("invalid field %s", f.Name)
			}
			names[f.Name] = true
			w, e := ParseWord(f.Slot)
			if e != nil {
				return nil, e
			}
			mask := new(big.Int).Lsh(new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(f.Width)), big.NewInt(1)), uint(f.Offset))
			if used[w] == nil {
				used[w] = new(big.Int)
			}
			if new(big.Int).And(used[w], mask).Sign() != 0 {
				return nil, errors.New("overlapping storage fields")
			}
			used[w].Or(used[w], mask)
			cp.fields = append(cp.fields, compiledField{f, w})
		}
		m.pools = append(m.pools, cp)
	}
	for _, g := range c.Guards {
		a, e := ParseAddress(g.Address)
		if e != nil {
			return nil, e
		}
		if _, ok := m.pins[a]; !ok {
			return nil, errors.New("guard missing code pin")
		}
		s, e := ParseWord(g.Slot)
		if e != nil {
			return nil, e
		}
		v, e := ParseWord(g.Value)
		if e != nil {
			return nil, e
		}
		m.guards = append(m.guards, compiledGuard{a, s, v})
	}
	if b := c.GasBudget; b != nil {
		if !b.WrappedNativeReviewed || b.LoseRaceBps > 10000 {
			return nil, errors.New("reviewed WETH gas budget required")
		}
		token, e := ParseAddress(b.SettlementToken)
		if e != nil {
			return nil, e
		}
		if _, ok := m.pins[token]; !ok {
			return nil, errors.New("WETH missing code pin")
		}
		limit, e := positiveDecimal(b.GasLimit)
		if e != nil {
			return nil, e
		}
		fee, e := positiveDecimal(b.MaxFeePerGas)
		if e != nil {
			return nil, e
		}
		maximum := new(big.Int).Mul(limit, fee)
		if maximum.BitLen() > 256 {
			return nil, errors.New("gas budget overflow")
		}
		m.budgetToken = token
		m.budgetWei = maximum.String()
	}
	return m, nil
}
