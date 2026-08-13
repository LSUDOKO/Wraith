package enclave

import (
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/LSUDOKO/Wraith/extension/internal/trigger"
)

// liveAgentInfo is a verbatim getAgentInfo response captured from Coston2 for
// agent 0x55c81526…, which at capture time reported NORMAL status, a vault
// collateral ratio of 545.88% and a pool ratio of 806.23%.
//
// Those ratios drift between calls — they are recomputed from live FTSO prices
// — which is why the fixture is frozen bytes rather than a number copied from
// an earlier query. The expectations below are the values encoded in *these*
// bytes, so they stay true forever.
//
// Real bytes rather than a hand-built fixture is the point here: the struct has
// 40 fields and a dynamic string that shifts the head, so a fixture written
// from the spec would encode exactly the same misreading the parser might make,
// and the test would pass while production broke.
const liveAgentInfo = "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fa41c694ed77ad59c4bc4ffe9ec32ed37e566f0000000000000000000000006b7fabf2313373f78ca5948cda28df255f1d6b24000000000000000000000000b19eb9db58173c003bb1b60a7a1658e7abf234ad000000000000000000000000bcfe22449699d5433d2d4ada4f9ddf4ceb0aea700000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000000fa000000000000000000000000021709e63fc7f264f329e0826ea82197694b827750000000000000000000000000000000000000000000000000000000000004e200000000000000000000000000000000000000000000000000000000000004e20000000000000000000000000000000000000000000000000000000000000021200000000000000000000000000000000000000000000000000000003ed31fb3d000000000000000000000000000000000000000000000000000000027cdff301000000000000000000000000000000000000000000000000000000000000d53c000000000000000000000000c67dce33d7a8efa5ffeb961899c73fe01bce927300000000000000000000000000000000000000000003789bdda4815829bae4bd000000000000000000000000000000000000000000029c2ca6b720db2e46466b0000000000000000000000000000000000000000000000000000000000013aef0000000000000000000000000000000000000000000278cd012b99c917e3d83800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000025161971c18f40a8a1a9500000000000000000000000000000000000000000000000000000000b70205ce0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000058a4e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b4e418d1e00000000000000000000000000000000000000000000000000000000b70205ce0000000000000000000000000000000000000000000000000000000a973f8750000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000026ac0000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000000fa000000000000000000000000000000000000000000000000000000000000000227234754b4a5279396d6a7847487731797a5331537274614b4355775436364d436350000000000000000000000000000000000000000000000000000000000000"

func TestParseAgentInfo_ReadsLiveChainResponse(t *testing.T) {
	got, err := parseAgentInfo(liveAgentInfo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got.Status != trigger.AgentNormal {
		t.Errorf("status = %d, want NORMAL", got.Status)
	}
	if got.VaultCRBIPS != 54588 {
		t.Errorf("vault CR = %d bips, want 54588 (545.88 percent)", got.VaultCRBIPS)
	}
	if got.PoolCRBIPS != 80623 {
		t.Errorf("pool CR = %d bips, want 80623 (806.23 percent)", got.PoolCRBIPS)
	}
}

func TestParseAgentInfo_RejectsShortResponse(t *testing.T) {
	if _, err := parseAgentInfo("0x00"); err == nil {
		t.Fatal("accepted a truncated response")
	}
}

func TestAgentReader_ReadsThroughRPC(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Method != "eth_call" {
			t.Errorf("unexpected rpc request: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]string{"result": liveAgentInfo})
	}))
	defer server.Close()

	reader := &AgentReader{RPCURL: server.URL, AssetManager: "0x0000000000000000000000000000000000000001"}
	health, err := reader.Read(context.Background(), "0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if health.VaultCRBIPS != 54588 {
		t.Fatalf("vault CR = %d, want 54588", health.VaultCRBIPS)
	}
}

func TestAgentReader_RejectsMalformedAgentAddress(t *testing.T) {
	reader := &AgentReader{RPCURL: "http://127.0.0.1:1", AssetManager: "0x01"}
	if _, err := reader.Read(context.Background(), "not-an-address"); err == nil {
		t.Fatal("accepted a malformed agent address")
	}
}

// The live reading must clear a realistic shield and breach a paranoid one,
// proving the parser and the decision agree end to end rather than in isolation.
func TestParseAgentInfo_FeedsTheShieldDecision(t *testing.T) {
	health, err := parseAgentInfo(liveAgentInfo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	terms := &trigger.Terms{
		Kind:              trigger.KindAgentHealth,
		Contract:          "0x00000000000000000000000000000000000000aa",
		Agent:             "0x55c815260cbe6c45fe5bfe5ff32e3c7d746f14dc",
		MinCollateralBIPS: 12_000, // 120 percent
		Action:            trigger.ActionSwap,
		MinOutOrLots:      big.NewInt(1),
		TokenOut:          "0x00000000000000000000000000000000000000bb",
	}

	quiet, err := trigger.EvaluateAgent(terms, health, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if quiet.Fire {
		t.Error("an agent at 545.88 percent must not trip a 120 percent shield")
	}

	terms.MinCollateralBIPS = 60_000 // 600 percent, above the live vault ratio
	loud, err := trigger.EvaluateAgent(terms, health, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !loud.Fire {
		t.Error("a 600 percent floor must trip against a 545.88 percent vault ratio")
	}
}
