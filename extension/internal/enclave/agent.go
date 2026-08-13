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

	"github.com/LSUDOKO/Wraith/extension/internal/trigger"
)

// AgentReader reads one FAssets agent's health from the AssetManager, from
// inside the enclave. Reading here rather than accepting a number from the
// keeper is the same trust decision the price path makes: a keeper can withhold
// a tick but cannot fake an agent's collateral.
type AgentReader struct {
	// RPCURL is the Flare JSON-RPC endpoint.
	RPCURL string
	// AssetManager is the FAssets AssetManager (AssetManagerFXRP on Coston2).
	AssetManager string
	// Client defaults to a 10s-timeout client.
	Client *http.Client
}

var getAgentInfoSelector = selector("getAgentInfo(address)")

// AgentInfo.Info head offsets, verified against the deployed struct. The struct
// carries a dynamic string at field 5, so the whole return is offset by one
// word; these indices are relative to the head, after that offset.
//
// Decoding positionally rather than through a generated binding keeps the
// enclave free of an ABI dependency, and the layout is pinned by the tests.
const (
	agentWordStatus  = 0
	agentWordVaultCR = 15
	agentWordPoolCR  = 19
	agentHeadWords   = 40
)

// Read fetches the current health of one agent vault.
func (r *AgentReader) Read(ctx context.Context, agentVault string) (*trigger.AgentHealth, error) {
	raw, err := hex.DecodeString(strings.TrimPrefix(strings.ToLower(agentVault), "0x"))
	if err != nil || len(raw) != 20 {
		return nil, fmt.Errorf("bad agent address %q", agentVault)
	}

	calldata := make([]byte, 4+32)
	copy(calldata, getAgentInfoSelector)
	copy(calldata[4+12:], raw)

	payload, _ := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "eth_call",
		Params: []any{
			map[string]string{"to": r.AssetManager, "data": "0x" + hex.EncodeToString(calldata)},
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
		return nil, fmt.Errorf("agent rpc: %w", err)
	}
	defer resp.Body.Close()

	var out rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("agent rpc decode: %w", err)
	}
	if out.Error != nil {
		return nil, fmt.Errorf("agent rpc error: %s", out.Error.Message)
	}

	return parseAgentInfo(out.Result)
}

// parseAgentInfo reads the fields Shield needs out of an ABI-encoded
// AgentInfo.Info.
func parseAgentInfo(result string) (*trigger.AgentHealth, error) {
	data, err := hex.DecodeString(strings.TrimPrefix(result, "0x"))
	if err != nil {
		return nil, fmt.Errorf("agent info: bad hex: %w", err)
	}

	// One leading word for the struct offset, then the head.
	const lead = 1
	if len(data) < (lead+agentHeadWords)*word {
		return nil, fmt.Errorf("agent info: short response (%d bytes)", len(data))
	}

	at := func(i int) *big.Int {
		start := (lead + i) * word
		return new(big.Int).SetBytes(data[start : start+word])
	}

	status := at(agentWordStatus)
	if !status.IsUint64() || status.Uint64() > uint64(trigger.AgentDestroying) {
		return nil, fmt.Errorf("agent info: unknown status %s", status)
	}

	vault, pool := at(agentWordVaultCR), at(agentWordPoolCR)
	if !vault.IsUint64() || !pool.IsUint64() {
		return nil, fmt.Errorf("agent info: collateral ratio out of range")
	}

	return &trigger.AgentHealth{
		Status:      trigger.AgentStatus(status.Uint64()),
		VaultCRBIPS: vault.Uint64(),
		PoolCRBIPS:  pool.Uint64(),
	}, nil
}
