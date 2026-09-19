package nativebridge

// These are captured RPC storage/view bytes, not synthetic pool balances.
// The test exercises the decoder used by Capture. It does NOT execute Nitro,
// verify code hashes/account proofs or reproduce a complete state transition.
import (
	"encoding/json"
	"math/big"
	"os"
	"testing"
)

func TestCapturedMainnetV4StorageDecoder(t *testing.T) {
	raw, e := os.ReadFile("../../test/fixtures/robinhood-mainnet-67237585.json")
	if e != nil {
		t.Fatal(e)
	}
	var sample struct {
		Kind  string `json:"kind"`
		Pools []struct {
			ID        string                               `json:"poolId"`
			Slot0     struct{ Storage, ViewResult string } `json:"slot0"`
			Liquidity struct{ Storage, ViewResult string } `json:"liquidity"`
		} `json:"pools"`
	}
	if e = json.Unmarshal(raw, &sample); e != nil {
		t.Fatal(e)
	}
	if sample.Kind != "captured-read-only-rpc-sample" || len(sample.Pools) != 2 {
		t.Fatal("wrong evidence fixture")
	}
	fields := []Field{{Name: "sqrtPriceX96", Offset: 0, Width: 160, Type: "uint"}, {Name: "tick", Offset: 160, Width: 24, Type: "int"}, {Name: "protocolFee", Offset: 184, Width: 24, Type: "uint"}, {Name: "lpFee", Offset: 208, Width: 24, Type: "uint"}}
	for _, p := range sample.Pools {
		t.Run(p.ID, func(t *testing.T) {
			packed, e := ParseWord(p.Slot0.Storage)
			if e != nil {
				t.Fatal(e)
			}
			if len(p.Slot0.ViewResult) != 2+4*64 {
				t.Fatal("wrong view shape")
			}
			for i, f := range fields {
				value, e := decode(packed, compiledField{Field: f})
				if e != nil {
					t.Fatal(e)
				}
				text := p.Slot0.ViewResult[2+i*64 : 2+(i+1)*64]
				expected, ok := new(big.Int).SetString(text, 16)
				if !ok {
					t.Fatal("invalid view word")
				}
				if f.Type == "int" {
					if expected.Bit(255) != 0 {
						expected.Sub(expected, new(big.Int).Lsh(big.NewInt(1), 256))
					}
					if value != expected.Int64() {
						t.Fatalf("tick: got %v expected %v", value, expected)
					}
				} else if value != expected.String() {
					t.Fatalf("%s: got %v expected %v", f.Name, value, expected)
				}
			}
			liquidity, e := ParseWord(p.Liquidity.Storage)
			if e != nil {
				t.Fatal(e)
			}
			value, e := decode(liquidity, compiledField{Field: Field{Width: 128, Type: "uint"}})
			if e != nil {
				t.Fatal(e)
			}
			ref, e := ParseWord(p.Liquidity.ViewResult)
			if e != nil {
				t.Fatal(e)
			}
			expected := new(big.Int).SetBytes(ref[:]).String()
			if value != expected || expected != "0" {
				t.Fatalf("captured active liquidity mismatch: %v %s", value, expected)
			}
		})
	}
}
