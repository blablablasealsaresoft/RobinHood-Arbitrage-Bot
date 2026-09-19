package nativebridge

import (
	"errors"
	"math/big"
)

// Optional interface implemented by the Nitro adapter using geth's Keccak256.
// The standalone observer never substitutes SHA3-256 for Ethereum Keccak.
// Keys are full ABI words, including sign extension for negative mapping keys.
type MappingReader interface {
	MappingSlot(key Word, base Word) Word
}
type TickWindowConfig struct {
	TickSpacing int32 `json:"tickSpacing"`
	MinWord     int32 `json:"minWord"`
	MaxWord     int32 `json:"maxWord"`
}
type TickLiquidity struct {
	Tick  int32  `json:"tick"`
	Gross string `json:"liquidityGross"`
	Net   string `json:"liquidityNet"`
}
type TickWindowState struct {
	Words []string        `json:"words"`
	Ticks []TickLiquidity `json:"ticks"`
}

func unsignedWord(value uint64) Word {
	var w Word
	new(big.Int).SetUint64(value).FillBytes(w[:])
	return w
}
func signedWord(value int64) Word {
	n := big.NewInt(value)
	if n.Sign() < 0 {
		n.Add(n, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	var w Word
	n.FillBytes(w[:])
	return w
}
func addSlot(w Word, delta uint64) (Word, error) {
	n := new(big.Int).Add(new(big.Int).SetBytes(w[:]), new(big.Int).SetUint64(delta))
	if n.BitLen() > 256 {
		return Word{}, errors.New("storage slot overflow")
	}
	var result Word
	n.FillBytes(result[:])
	return result, nil
}
func fieldSlot(p compiledPool, name string) Word {
	for _, f := range p.fields {
		if f.Name == name {
			return f.slot
		}
	}
	return Word{}
}
func configureWindow(cp *compiledPool, p Pool) error {
	c := p.TickWindow
	if p.Kind != "v4" || c.TickSpacing < 1 || c.TickSpacing > 32767 || c.MinWord < -32768 || c.MaxWord > 32767 || c.MaxWord < c.MinWord || c.MaxWord-c.MinWord >= 8 {
		return errors.New("invalid/unsupported tick window")
	}
	base := fieldSlot(*cp, "sqrtPriceX96")
	liq, err := addSlot(base, 3)
	if err != nil {
		return err
	}
	offsets := map[string]uint16{"sqrtPriceX96": 0, "tick": 160, "protocolFee": 184, "lpFee": 208, "liquidity": 0}
	for _, f := range cp.fields {
		expected := base
		if f.Name == "liquidity" {
			expected = liq
		}
		if f.slot != expected || f.Offset != offsets[f.Name] {
			return errors.New("tick window requires canonical V4 field layout")
		}
	}
	cp.keyHash, err = ParseWord(p.PoolKeyHash)
	if err != nil {
		return err
	}
	copy := *c
	cp.window = &copy
	return nil
}

func captureWindow(p compiledPool, reader Reader, read func(Address, Word) (Word, error)) (*TickWindowState, error) {
	hasher, ok := reader.(MappingReader)
	if !ok {
		return nil, errors.New("tick window requires Ethereum mapping-slot reader")
	}
	base := hasher.MappingSlot(p.keyHash, unsignedWord(6))
	if base != fieldSlot(p, "sqrtPriceX96") {
		return nil, errors.New("V4 pool key/storage base mismatch")
	}
	bitmapBase, err := addSlot(base, 5)
	if err != nil {
		return nil, err
	}
	ticksBase, err := addSlot(base, 4)
	if err != nil {
		return nil, err
	}
	half := new(big.Int).Lsh(big.NewInt(1), 128)
	mask := new(big.Int).Sub(new(big.Int).Set(half), big.NewInt(1))
	result := &TickWindowState{Words: make([]string, 0, p.window.MaxWord-p.window.MinWord+1), Ticks: make([]TickLiquidity, 0)}
	for position := p.window.MinWord; position <= p.window.MaxWord; position++ {
		word, err := read(p.address, hasher.MappingSlot(signedWord(int64(position)), bitmapBase))
		if err != nil {
			return nil, err
		}
		bits := new(big.Int).SetBytes(word[:])
		result.Words = append(result.Words, bits.String())
		for bits.Sign() != 0 {
			bit := bits.TrailingZeroBits()
			index := (int64(position)*256 + int64(bit)) * int64(p.window.TickSpacing)
			if index < -887272 || index > 887272 {
				return nil, errors.New("initialized tick outside global range")
			}
			if len(result.Ticks) >= 256 {
				return nil, errors.New("initialized tick budget exceeded")
			}
			raw, err := read(p.address, hasher.MappingSlot(signedWord(index), ticksBase))
			if err != nil {
				return nil, err
			}
			n := new(big.Int).SetBytes(raw[:])
			gross := new(big.Int).And(new(big.Int).Set(n), mask)
			net := new(big.Int).Rsh(n, 128)
			if net.Bit(127) != 0 {
				net.Sub(net, half)
			}
			abs := new(big.Int).Abs(new(big.Int).Set(net))
			parity := new(big.Int).Add(new(big.Int).Set(gross), net)
			if gross.Sign() == 0 || abs.Cmp(gross) > 0 || parity.Bit(0) != 0 {
				return nil, errors.New("inconsistent initialized tick liquidity")
			}
			result.Ticks = append(result.Ticks, TickLiquidity{int32(index), gross.String(), net.String()})
			bits.SetBit(bits, int(bit), 0)
		}
	}
	return result, nil
}
