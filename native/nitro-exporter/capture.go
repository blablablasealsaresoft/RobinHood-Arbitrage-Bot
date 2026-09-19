package nativebridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
)

type Reader interface {
	CodeHash(Address) (Word, error)
	Storage(Address, Word) (Word, error)
}
type Head struct {
	Sequence, Number, Timestamp uint64
	Hash, ParentHash, StateRoot Word
}
type Log struct {
	Address string   `json:"address"`
	Topics  []string `json:"topics"`
	Data    string   `json:"data"`
	Removed bool     `json:"removed"`
}
type Receipt struct {
	Type              string `json:"type"`
	TxHash            string `json:"txHash"`
	BlockNumber       string `json:"blockNumber"`
	BlockHash         string `json:"blockHash"`
	Nonce             string `json:"nonce"`
	Status            uint64 `json:"status"`
	FeeModel          string `json:"feeModel"`
	GasUsed           string `json:"gasUsed"`
	EffectiveGasPrice string `json:"effectiveGasPrice"`
	Logs              []Log  `json:"logs"`
	ExecutionSource   Source `json:"executionSource"`
}
type Frame struct {
	Type            string           `json:"type"`
	Schema          int              `json:"schema"`
	ChainID         uint64           `json:"chainId"`
	Complete        bool             `json:"complete"`
	Sequence        string           `json:"sequence"`
	BlockNumber     string           `json:"blockNumber"`
	BlockHash       string           `json:"blockHash"`
	ParentHash      string           `json:"parentHash"`
	FeedBlockHash   string           `json:"feedBlockHash"`
	Timestamp       string           `json:"timestamp"`
	StateRoot       string           `json:"stateRoot"`
	ExecutionSource Source           `json:"executionSource"`
	Updates         []map[string]any `json:"updates"`
}
type Cost struct {
	SettlementToken string `json:"settlementToken"`
	Numerator       string `json:"settlementUnitsPerWeiNumerator"`
	Denominator     string `json:"settlementUnitsPerWeiDenominator"`
	SuccessGasWei   string `json:"successGasWei"`
	RevertGasWei    string `json:"revertGasWei"`
	LoseRaceBps     string `json:"loseRaceBps"`
	ValidUntilBlock string `json:"validUntilBlock"`
}
type CostsFrame struct {
	Type            string `json:"type"`
	ExecutionSource Source `json:"executionSource"`
	Entries         []Cost `json:"entries"`
}

// Batch owns its fully copied JSON bytes. No mutable StateDB escapes capture.
type Batch struct {
	Head            Head
	Snapshot, Block []byte
	Costs           []byte
	Receipts        [][]byte
}

func line(v any) ([]byte, error) {
	b, e := json.Marshal(v)
	if e != nil {
		return nil, e
	}
	if len(b) > MaxFrameBytes {
		return nil, errors.New("frame size limit")
	}
	return append(b, '\n'), nil
}
func decode(w Word, f compiledField) (any, error) {
	n := new(big.Int).Rsh(new(big.Int).SetBytes(w[:]), uint(f.Offset))
	n.And(n, new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(f.Width)), big.NewInt(1)))
	switch f.Type {
	case "uint":
		return n.String(), nil
	case "int":
		if n.Bit(int(f.Width)-1) != 0 {
			n.Sub(n, new(big.Int).Lsh(big.NewInt(1), uint(f.Width)))
		}
		return n.Int64(), nil // only reviewed int24 tick fields are allowed
	case "bool":
		if n.Cmp(big.NewInt(1)) > 0 {
			return nil, errors.New("invalid Solidity bool")
		}
		return n.Sign() != 0, nil
	}
	return nil, errors.New("unsupported field type")
}
func (m *Manifest) Capture(h Head, r Reader, receipts []Receipt) (*Batch, error) {
	if h.Hash == (Word{}) || h.ParentHash == (Word{}) || h.StateRoot == (Word{}) || h.Number == math.MaxUint64 || h.Sequence == math.MaxUint64 {
		return nil, errors.New("invalid head")
	}
	if len(receipts) > 256 {
		return nil, errors.New("receipt count limit")
	}
	for a, expected := range m.pins {
		got, e := r.CodeHash(a)
		if e != nil {
			return nil, e
		}
		if got != expected {
			return nil, fmt.Errorf("runtime code changed: %s", a.String())
		}
	}
	cache := map[struct {
		a Address
		s Word
	}]Word{}
	read := func(a Address, s Word) (Word, error) {
		key := struct {
			a Address
			s Word
		}{a, s}
		if v, ok := cache[key]; ok {
			return v, nil
		}
		v, e := r.Storage(a, s)
		if e == nil {
			cache[key] = v
		}
		return v, e
	}
	for _, g := range m.guards {
		v, e := read(g.address, g.slot)
		if e != nil {
			return nil, e
		}
		if v != g.value {
			return nil, errors.New("storage guard changed")
		}
	}
	frame := Frame{Type: "snapshot", Schema: 1, ChainID: 4663, Complete: true, Sequence: strconv.FormatUint(h.Sequence, 10), BlockNumber: strconv.FormatUint(h.Number, 10), BlockHash: h.Hash.String(), ParentHash: h.ParentHash.String(), FeedBlockHash: h.Hash.String(), Timestamp: strconv.FormatUint(h.Timestamp, 10), StateRoot: h.StateRoot.String(), ExecutionSource: m.source, Updates: make([]map[string]any, 0, len(m.pools))}
	for _, p := range m.pools {
		update := map[string]any{"poolId": p.id}
		for _, f := range p.fields {
			word, e := read(p.address, f.slot)
			if e != nil {
				return nil, e
			}
			value, e := decode(word, f)
			if e != nil {
				return nil, e
			}
			update[f.Name] = value
		}
		frame.Updates = append(frame.Updates, update)
	}
	snapshot, e := line(frame)
	if e != nil {
		return nil, e
	}
	frame.Type = "block"
	block, e := line(frame)
	if e != nil {
		return nil, e
	}
	batch := &Batch{Head: h, Snapshot: snapshot, Block: block}
	if m.config.GasBudget != nil {
		b := m.config.GasBudget
		batch.Costs, e = line(CostsFrame{"costs", m.source, []Cost{{m.budgetToken.String(), "1", "1", m.budgetWei, m.budgetWei, strconv.FormatUint(uint64(b.LoseRaceBps), 10), strconv.FormatUint(h.Number+1, 10)}}})
		if e != nil {
			return nil, e
		}
	}
	seen := map[string]bool{}
	total := len(snapshot) + len(block) + len(batch.Costs)
	for _, receipt := range receipts {
		tx, e := ParseWord(receipt.TxHash)
		if e != nil || tx == (Word{}) || seen[tx.String()] {
			return nil, errors.New("invalid/duplicate receipt hash")
		}
		seen[tx.String()] = true
		if receipt.BlockNumber != frame.BlockNumber || receipt.BlockHash != frame.BlockHash || receipt.Status > 1 || len(receipt.Logs) > 4096 || receipt.FeeModel != FeeModel {
			return nil, errors.New("receipt block/status/fee mismatch")
		}
		for _, c := range receipt.Nonce {
			if c < '0' || c > '9' {
				return nil, errors.New("receipt nonce must be unsigned decimal")
			}
		}
		nonce, ok := new(big.Int).SetString(receipt.Nonce, 10)
		if !ok || nonce.Sign() < 0 || !nonce.IsUint64() {
			return nil, errors.New("receipt nonce")
		}
		if _, e := positiveDecimal(receipt.GasUsed); e != nil {
			return nil, e
		}
		if _, e := positiveDecimal(receipt.EffectiveGasPrice); e != nil {
			return nil, e
		}
		for _, l := range receipt.Logs {
			if _, e := ParseAddress(l.Address); e != nil {
				return nil, e
			}
			if l.Removed || len(l.Topics) > 4 {
				return nil, errors.New("invalid receipt log")
			}
			for _, t := range l.Topics {
				if _, e := ParseWord(t); e != nil {
					return nil, e
				}
			}
			if len(l.Data)%2 != 0 || len(l.Data) < 2 || len(l.Data) > MaxFrameBytes {
				return nil, errors.New("invalid log data")
			}
			if _, e := parseHex(l.Data, (len(l.Data)-2)/2); e != nil {
				return nil, e
			}
		}
		receipt.Type = "receipt"
		receipt.ExecutionSource = m.source
		raw, e := line(receipt)
		if e != nil {
			return nil, e
		}
		total += len(raw)
		if total > 8*MaxFrameBytes {
			return nil, errors.New("batch size limit")
		}
		batch.Receipts = append(batch.Receipts, raw)
	}
	return batch, nil
}
