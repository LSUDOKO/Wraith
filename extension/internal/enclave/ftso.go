package enclave

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/sha3"

	"github.com/LSUDOKO/Wraith/extension/internal/trigger"
)

// FtsoReader reads block-latency price feeds via eth_call from inside the
// enclave. Reading here, rather than accepting a price from the keeper, is a
// trust decision: the keeper can withhold ticks but cannot lie about a price.
type FtsoReader struct {
	// RPCURL is the Flare JSON-RPC endpoint.
	RPCURL string
	// FtsoV2 is the FtsoV2 contract address (getTestFtsoV2 on Coston2).
	FtsoV2 string
	// Client defaults to a 10s-timeout client.
	Client *http.Client
}

// getFeedByIdSelector is computed at init rather than hardcoded, so it cannot
// silently drift from the signature.
var getFeedByIdSelector = selector("getFeedById(bytes21)")

func selector(signature string) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte(signature))
	return h.Sum(nil)[:4]
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResponse struct {
	Result string `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Read fetches one feed observation. feedID is the 21-byte id as 0x-hex.
func (r *FtsoReader) Read(ctx context.Context, feedID string) (*trigger.Observation, error) {
	raw, err := hex.DecodeString(strings.TrimPrefix(feedID, "0x"))
	if err != nil || len(raw) != 21 {
		return nil, fmt.Errorf("bad feed id %q", feedID)
	}

	// calldata: selector ++ bytes21 left-aligned in one word.
	calldata := make([]byte, 4+32)
	copy(calldata, getFeedByIdSelector)
	copy(calldata[4:], raw)

	payload, _ := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "eth_call",
		Params: []any{
			map[string]string{"to": r.FtsoV2, "data": "0x" + hex.EncodeToString(calldata)},
			"latest",
		},
	})

	client := r.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.RPCURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("rpc: %w", err)
	}
	defer resp.Body.Close()

	var out rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("rpc decode: %w", err)
	}
	if out.Error != nil {
		return nil, fmt.Errorf("rpc error: %s", out.Error.Message)
	}

	// Return ABI: (uint256 value, int8 decimals, uint64 timestamp).
	data, err := hex.DecodeString(strings.TrimPrefix(out.Result, "0x"))
	if err != nil || len(data) < 3*32 {
		return nil, fmt.Errorf("short eth_call result (%d bytes)", len(data))
	}

	value := new(big.Int).SetBytes(data[0:32])

	decimalsWord := new(big.Int).SetBytes(data[32:64])
	// int8 arrives sign-extended across the word; fold it back.
	if decimalsWord.BitLen() > 8 {
		decimalsWord = new(big.Int).Sub(decimalsWord, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	if !decimalsWord.IsInt64() || decimalsWord.Int64() > 127 || decimalsWord.Int64() < -128 {
		return nil, fmt.Errorf("feed decimals out of int8 range")
	}

	timestamp := new(big.Int).SetBytes(data[64:96])
	if !timestamp.IsUint64() {
		return nil, fmt.Errorf("feed timestamp out of range")
	}

	return &trigger.Observation{
		Value:    value,
		Decimals: int8(decimalsWord.Int64()),
		Time:     time.Unix(int64(timestamp.Uint64()), 0),
	}, nil
}
