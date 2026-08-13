package enclave

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/LSUDOKO/Wraith/extension/internal/trigger"
)

const (
	wraithAddr = "0x00000000000000000000000000000000000000aa"
	tokenOut   = "0x00000000000000000000000000000000000000bb"
	feedID     = "0x01464c522f55534400000000000000000000000000"
)

var now = time.Unix(1_000_000, 0)

// --- test-side ABI encoders, written independently of the production decoders ---

func pad(b []byte) []byte {
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func uintWord(v *big.Int) []byte { return pad(v.Bytes()) }

func addrWord(t *testing.T, addr string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(strings.TrimPrefix(addr, "0x"))
	if err != nil {
		t.Fatalf("bad test address: %v", err)
	}
	return pad(raw)
}

func stringTail(s string) []byte {
	data := []byte(s)
	out := uintWord(big.NewInt(int64(len(data))))
	padded := make([]byte, (len(data)+31)/32*32)
	copy(padded, data)
	return append(out, padded...)
}

// encodeTerms mirrors frontend/lib/wraith.ts sealTerms's ABI layout.
func encodeTerms(t *testing.T, direction string, thresholdE18 *big.Int, action uint8, expiry uint64) []byte {
	return encodeTermsBracket(t, direction, thresholdE18, action, expiry, big.NewInt(0))
}

// encodeTermsBracket mirrors frontend sealTerms including the optional second
// bracket leg (slot 9). Zero means a plain single-leg order.
func encodeTermsBracket(
	t *testing.T, direction string, thresholdE18 *big.Int, action uint8, expiry uint64, second *big.Int,
) []byte {
	return encodeTermsFull(t, direction, thresholdE18, action, expiry, second, 0, zeroAddr, 0)
}

const zeroAddr = "0x0000000000000000000000000000000000000000"

// encodeTermsFull mirrors the frontend layout including the Shield slots.
func encodeTermsFull(
	t *testing.T, direction string, thresholdE18 *big.Int, action uint8, expiry uint64, second *big.Int,
	kind uint8, agent string, minCollateralBIPS uint64,
) []byte {
	return encodeTermsAll(t, direction, thresholdE18, action, expiry, second, kind, agent, minCollateralBIPS, 0)
}

// encodeTermsAll mirrors the full frontend layout, trail distance included.
func encodeTermsAll(
	t *testing.T, direction string, thresholdE18 *big.Int, action uint8, expiry uint64, second *big.Int,
	kind uint8, agent string, minCollateralBIPS uint64, trailBIPS uint64,
) []byte {
	return encodeTermsTWAP(t, direction, thresholdE18, action, expiry, second, kind, agent,
		minCollateralBIPS, trailBIPS, [32]byte{}, 0, 0, 0)
}

// encodeTermsTWAP mirrors the complete frontend layout.
func encodeTermsTWAP(
	t *testing.T, direction string, thresholdE18 *big.Int, action uint8, expiry uint64, second *big.Int,
	kind uint8, agent string, minCollateralBIPS uint64, trailBIPS uint64,
	seed [32]byte, chunks uint64, startAt uint64, endAt uint64,
) []byte {
	t.Helper()

	feed, _ := hex.DecodeString(strings.TrimPrefix(feedID, "0x"))
	feedWord := make([]byte, 32)
	copy(feedWord, feed) // bytes21 is left-aligned

	head := make([]byte, 0, 9*32)
	head = append(head, addrWord(t, wraithAddr)...)
	head = append(head, feedWord...)

	dirTail := stringTail(direction)
	underTail := stringTail("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe")

	dirOffset := big.NewInt(18 * 32)
	underOffset := new(big.Int).Add(dirOffset, big.NewInt(int64(len(dirTail))))

	head = append(head, uintWord(dirOffset)...)
	head = append(head, uintWord(thresholdE18)...)
	head = append(head, uintWord(big.NewInt(int64(action)))...)
	head = append(head, uintWord(big.NewInt(3))...) // minOutOrLots
	head = append(head, addrWord(t, tokenOut)...)
	head = append(head, uintWord(underOffset)...)
	head = append(head, uintWord(new(big.Int).SetUint64(expiry))...)
	head = append(head, uintWord(second)...)
	head = append(head, uintWord(big.NewInt(int64(kind)))...)
	head = append(head, addrWord(t, agent)...)
	head = append(head, uintWord(new(big.Int).SetUint64(minCollateralBIPS))...)
	head = append(head, uintWord(new(big.Int).SetUint64(trailBIPS))...)
	head = append(head, seed[:]...)
	head = append(head, uintWord(new(big.Int).SetUint64(chunks))...)
	head = append(head, uintWord(new(big.Int).SetUint64(startAt))...)
	head = append(head, uintWord(new(big.Int).SetUint64(endAt))...)

	out := append(head, dirTail...)
	return append(out, underTail...)
}

// encodeInstruction mirrors abi.encode(orderId, address(this), encrypted) from tick().
func encodeInstruction(t *testing.T, orderID uint64, contract string, ciphertext []byte) []byte {
	return encodeInstructionPeak(t, orderID, contract, ciphertext, big.NewInt(0))
}

// encodeInstructionPeak mirrors tick(): the message carries the running peak so
// a trailing stop can be judged without the enclave storing anything.
func encodeInstructionPeak(
	t *testing.T, orderID uint64, contract string, ciphertext []byte, peak *big.Int,
) []byte {
	return encodeInstructionFull(t, orderID, contract, ciphertext, peak, big.NewInt(0))
}

// encodeInstructionFull mirrors tick(): the message carries both the running
// peak and the unspent escrow, so trailing and chunked orders can be judged
// without the enclave storing anything.
func encodeInstructionFull(
	t *testing.T, orderID uint64, contract string, ciphertext []byte, peak, remaining *big.Int,
) []byte {
	t.Helper()
	head := uintWord(new(big.Int).SetUint64(orderID))
	head = append(head, addrWord(t, contract)...)
	head = append(head, uintWord(big.NewInt(5*32))...)
	head = append(head, uintWord(peak)...)
	head = append(head, uintWord(remaining)...)
	head = append(head, uintWord(big.NewInt(int64(len(ciphertext))))...)
	padded := make([]byte, (len(ciphertext)+31)/32*32)
	copy(padded, ciphertext)
	return append(head, padded...)
}

// --- decoder tests ---

func TestDecodeInstruction(t *testing.T) {
	cipher := []byte("not really a ciphertext but shaped like one")
	got, err := DecodeInstruction(encodeInstruction(t, 7, wraithAddr, cipher))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.OrderID != 7 || got.Contract != wraithAddr || string(got.Ciphertext) != string(cipher) {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

func TestDecodeInstruction_RejectsTruncatedData(t *testing.T) {
	// Exactly one word of ciphertext, so the final byte is payload rather than
	// ABI padding — truncating padding alone is legal ABI.
	full := encodeInstruction(t, 7, wraithAddr, []byte("0123456789abcdef0123456789abcdef"))
	for _, cut := range []int{0, 31, 64, len(full) - 1} {
		if _, err := DecodeInstruction(full[:cut]); err == nil {
			t.Errorf("accepted %d-byte truncation", cut)
		}
	}
}

func TestDecodeTerms(t *testing.T) {
	threshold := new(big.Int).Mul(big.NewInt(2), big.NewInt(1e18))
	got, err := DecodeTerms(encodeTerms(t, "below", threshold, 1, 12345))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got.Contract != wraithAddr || got.FeedID != feedID {
		t.Errorf("identity fields wrong: %+v", got)
	}
	if got.Direction != trigger.Below || got.ThresholdE18.Cmp(threshold) != 0 {
		t.Errorf("condition fields wrong: %+v", got)
	}
	if got.Action != trigger.ActionRedeem || got.MinOutOrLots.Int64() != 3 || got.Expiry != 12345 {
		t.Errorf("settlement fields wrong: %+v", got)
	}
	if got.UnderlyingAddress != "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" {
		t.Errorf("underlying wrong: %q", got.UnderlyingAddress)
	}
}

func TestEncodeResult_CarriesNoConditionFields(t *testing.T) {
	terms := &trigger.Terms{
		Contract:          wraithAddr,
		FeedID:            feedID,
		Direction:         trigger.Below,
		ThresholdE18:      big.NewInt(123456789), // a distinctive byte pattern
		Action:            trigger.ActionSwap,
		MinOutOrLots:      big.NewInt(1),
		TokenOut:          tokenOut,
		UnderlyingAddress: "",
		Expiry:            99,
	}

	data, err := EncodeResult(4, wraithAddr, terms, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The result must never leak the secret. Neither the threshold bytes nor
	// the direction string may appear anywhere in the payload.
	if strings.Contains(hex.EncodeToString(data), hex.EncodeToString(terms.ThresholdE18.Bytes())) {
		t.Fatal("threshold bytes leaked into the settlement result")
	}
	if strings.Contains(string(data), "below") {
		t.Fatal("direction leaked into the settlement result")
	}
}

// --- FTSO reader ---

func ftsoServer(t *testing.T, value *big.Int, decimals int8, ts time.Time) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Method != "eth_call" {
			t.Errorf("unexpected rpc request: %v %s", err, req.Method)
		}

		out := make([]byte, 0, 96)
		out = append(out, pad(value.Bytes())...)
		decWord := new(big.Int).SetInt64(int64(decimals))
		if decimals < 0 {
			// two's complement across the full word, as Solidity returns int8
			decWord = new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 256), decWord)
		}
		out = append(out, decWord.Bytes()...)
		out = out[:32+32] // decWord.Bytes() of a full-word value is exactly 32 bytes for negatives; re-pad for positives
		if decimals >= 0 {
			out = append(out[:32], pad(decWord.Bytes())...)
		}
		out = append(out, pad(new(big.Int).SetInt64(ts.Unix()).Bytes())...)

		json.NewEncoder(w).Encode(map[string]string{"result": "0x" + hex.EncodeToString(out)})
	}))
}

func TestFtsoReader_ReadsPositiveDecimals(t *testing.T) {
	server := ftsoServer(t, big.NewInt(7_000_000), 6, now)
	defer server.Close()

	reader := &FtsoReader{RPCURL: server.URL, FtsoV2: "0x0000000000000000000000000000000000000001"}
	obs, err := reader.Read(context.Background(), feedID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if obs.Value.Int64() != 7_000_000 || obs.Decimals != 6 || !obs.Time.Equal(now) {
		t.Fatalf("bad observation: %+v", obs)
	}
}

func TestFtsoReader_FoldsNegativeDecimals(t *testing.T) {
	server := ftsoServer(t, big.NewInt(7), -2, now)
	defer server.Close()

	reader := &FtsoReader{RPCURL: server.URL, FtsoV2: "0x0000000000000000000000000000000000000001"}
	obs, err := reader.Read(context.Background(), feedID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if obs.Decimals != -2 {
		t.Fatalf("negative decimals folded wrong: %d", obs.Decimals)
	}
}

func TestFtsoReader_RejectsRpcError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": "execution reverted"}})
	}))
	defer server.Close()

	reader := &FtsoReader{RPCURL: server.URL, FtsoV2: "0x0000000000000000000000000000000000000001"}
	if _, err := reader.Read(context.Background(), feedID); err == nil {
		t.Fatal("accepted an rpc error response")
	}
}

// --- end-to-end handler ---

// harness wires the handler to fake decrypt and RPC servers. plaintext is what
// the decrypt endpoint returns for any ciphertext.
func harness(t *testing.T, plaintext []byte, price *big.Int) (*Handler, func()) {
	t.Helper()

	decryptSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Assert the request matches tee-node's DecryptRequest: a []byte field
		// named encryptedMessage, which JSON-encodes as base64. Sending hex here
		// is what produced a 400 from a reachable server in the live stack.
		var req struct {
			EncryptedMessage []byte `json:"encryptedMessage"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.EncryptedMessage) == 0 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string][]byte{"decryptedMessage": plaintext})
	}))
	rpcSrv := ftsoServer(t, price, 6, now)

	h := &Handler{
		Decryptor: &Decryptor{BaseURL: decryptSrv.URL},
		Ftso:      &FtsoReader{RPCURL: rpcSrv.URL, FtsoV2: "0x0000000000000000000000000000000000000001"},
		Now:       func() time.Time { return now },
	}
	return h, func() { decryptSrv.Close(); rpcSrv.Close() }
}

func stopLossTerms(t *testing.T) []byte {
	// Stop-loss at $2.00, expiring an hour from "now".
	return encodeTerms(t, "below", new(big.Int).Mul(big.NewInt(2), big.NewInt(1e18)), 0, uint64(now.Unix())+3600)
}

func TestHandler_NoOpWhenConditionNotMet(t *testing.T) {
	h, cleanup := harness(t, stopLossTerms(t), big.NewInt(5_000_000)) // $5 > $2 stop
	defer cleanup()

	out := h.Evaluate(context.Background(), encodeInstruction(t, 1, wraithAddr, []byte("cipher")))
	if out.Status != 1 {
		t.Fatalf("no-op must be status 1, got %d (%s)", out.Status, out.Log)
	}
	if len(out.Data) != 0 {
		t.Fatal("no-op must carry no data")
	}
}

func TestHandler_FiresWhenConditionMet(t *testing.T) {
	h, cleanup := harness(t, stopLossTerms(t), big.NewInt(1_500_000)) // $1.50 <= $2 stop
	defer cleanup()

	out := h.Evaluate(context.Background(), encodeInstruction(t, 1, wraithAddr, []byte("cipher")))
	if out.Status != 1 || len(out.Data) == 0 {
		t.Fatalf("expected fired result, got status %d, %d bytes (%s)", out.Status, len(out.Data), out.Log)
	}

	// The result must decode to the settlement the contract expects.
	orderID := new(big.Int).SetBytes(out.Data[:32])
	if orderID.Uint64() != 1 {
		t.Fatalf("result orderId = %d", orderID.Uint64())
	}
}

func TestHandler_RejectsTermsBoundToAnotherContract(t *testing.T) {
	h, cleanup := harness(t, stopLossTerms(t), big.NewInt(1_500_000))
	defer cleanup()

	// The instruction claims a different WraithOrders deployment than the
	// contract named inside the sealed terms.
	other := "0x00000000000000000000000000000000000000cc"
	out := h.Evaluate(context.Background(), encodeInstruction(t, 1, other, []byte("cipher")))
	if out.Status != 0 {
		t.Fatalf("cross-contract replay accepted: status %d (%s)", out.Status, out.Log)
	}
}

func TestHandler_ErrorsOnExpiredOrder(t *testing.T) {
	expired := encodeTerms(t, "below", big.NewInt(1e18), 0, uint64(now.Unix()))
	h, cleanup := harness(t, expired, big.NewInt(1))
	defer cleanup()

	out := h.Evaluate(context.Background(), encodeInstruction(t, 1, wraithAddr, []byte("cipher")))
	if out.Status != 0 {
		t.Fatalf("expired order evaluated: status %d (%s)", out.Status, out.Log)
	}
}

func TestHandler_ErrorsOnGarbagePlaintext(t *testing.T) {
	h, cleanup := harness(t, []byte("garbage"), big.NewInt(1))
	defer cleanup()

	out := h.Evaluate(context.Background(), encodeInstruction(t, 1, wraithAddr, []byte("cipher")))
	if out.Status != 0 {
		t.Fatalf("garbage plaintext accepted: status %d", out.Status)
	}
}

// The encoder and decoder must agree on the bracket slot, or a take-profit leg
// silently vanishes and the order becomes a plain stop.
func TestDecodeTerms_RoundTripsTheBracketLeg(t *testing.T) {
	stop := new(big.Int).Mul(big.NewInt(2), big.NewInt(1e18))
	takeProfit := new(big.Int).Mul(big.NewInt(5), big.NewInt(1e18))

	got, err := DecodeTerms(encodeTermsBracket(t, "below", stop, 0, 12345, takeProfit))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.SecondThresholdE18 == nil {
		t.Fatal("bracket leg was dropped in decoding")
	}
	if got.SecondThresholdE18.Cmp(takeProfit) != 0 {
		t.Fatalf("bracket leg = %s, want %s", got.SecondThresholdE18, takeProfit)
	}
}

// Zero must decode to nil, not to a take-profit at price zero — which would
// make every single-leg stop fire immediately.
func TestDecodeTerms_ZeroBracketMeansSingleLeg(t *testing.T) {
	stop := new(big.Int).Mul(big.NewInt(2), big.NewInt(1e18))

	got, err := DecodeTerms(encodeTermsBracket(t, "below", stop, 0, 12345, big.NewInt(0)))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.SecondThresholdE18 != nil {
		t.Fatalf("zero must mean no bracket, got %s", got.SecondThresholdE18)
	}
}

// --- Dummy ticks (side-channel resistance) ---
//
// A no-op and a fired result must be indistinguishable in status, so an observer
// watching the proxy cannot infer from tick shape alone whether an order is near
// its trigger. Only the presence of settlement data separates them, and that is
// only visible once a result is actually relayed on-chain.

func TestHandler_NoOpAndFiredShareTheSameStatus(t *testing.T) {
	quiet, cleanupQuiet := harness(t, stopLossTerms(t), big.NewInt(5_000_000)) // above the stop
	defer cleanupQuiet()
	noop := quiet.Evaluate(context.Background(), encodeInstruction(t, 1, wraithAddr, []byte("cipher")))

	loud, cleanupLoud := harness(t, stopLossTerms(t), big.NewInt(1_500_000)) // through the stop
	defer cleanupLoud()
	fired := loud.Evaluate(context.Background(), encodeInstruction(t, 1, wraithAddr, []byte("cipher")))

	if noop.Status != fired.Status {
		t.Fatalf("status leaks the outcome: no-op=%d fired=%d", noop.Status, fired.Status)
	}
}

// The enclave-local log line must never describe how close an order sits to its
// trigger, since logs can escape the enclave in ways the result payload cannot.
func TestHandler_NoOpLogRevealsNothingAboutTheThreshold(t *testing.T) {
	h, cleanup := harness(t, stopLossTerms(t), big.NewInt(5_000_000))
	defer cleanup()

	out := h.Evaluate(context.Background(), encodeInstruction(t, 1, wraithAddr, []byte("cipher")))

	for _, leak := range []string{"2000000000000000000", "below", "threshold", "5000000"} {
		if strings.Contains(out.Log, leak) {
			t.Errorf("no-op log leaked %q: %s", leak, out.Log)
		}
	}
}

// A Shield order must survive the wire: kind, agent and collateral floor all
// decode, or the enclave would evaluate it as a price order against an empty
// feed.
func TestDecodeTerms_RoundTripsAShieldOrder(t *testing.T) {
	agent := "0x55c815260cbe6c45fe5bfe5ff32e3c7d746f14dc"

	got, err := DecodeTerms(encodeTermsFull(
		t, "below", big.NewInt(1), 0, 12345, big.NewInt(0), 1, agent, 12_000,
	))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got.Kind != trigger.KindAgentHealth {
		t.Errorf("kind = %d, want KindAgentHealth", got.Kind)
	}
	if !strings.EqualFold(got.Agent, agent) {
		t.Errorf("agent = %s, want %s", got.Agent, agent)
	}
	if got.MinCollateralBIPS != 12_000 {
		t.Errorf("floor = %d bips, want 12000", got.MinCollateralBIPS)
	}
}

// A price order must keep decoding as one; the added slots default to a price
// kind so previously-sealed orders do not change meaning.
func TestDecodeTerms_PriceOrderStaysAPriceOrder(t *testing.T) {
	got, err := DecodeTerms(encodeTerms(t, "below", big.NewInt(1), 0, 12345))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Kind != trigger.KindPrice {
		t.Fatalf("kind = %d, want KindPrice", got.Kind)
	}
}

// A trailing order that has only risen must still report its new peak, or the
// contract's high-water mark never moves and the stop never trails.
func TestHandler_RaisesThePeakWithoutSettling(t *testing.T) {
	terms := encodeTermsTrailing(t, 500, uint64(now.Unix())+3600)
	h, cleanup := harness(t, terms, big.NewInt(5_000_000)) // $5
	defer cleanup()

	out := h.Evaluate(context.Background(), encodeInstructionPeak(t, 1, wraithAddr, []byte("cipher"), big.NewInt(0)))

	if out.Status != 1 {
		t.Fatalf("status = %d (%s)", out.Status, out.Log)
	}
	if len(out.Data) == 0 {
		t.Fatal("a rising trailing order must emit a peak update")
	}

	// The result must be a TRACK, which settles nothing.
	action := new(big.Int).SetBytes(out.Data[2*32 : 3*32])
	if action.Uint64() != uint64(trigger.ActionTrack) {
		t.Fatalf("action = %d, want ActionTrack", action.Uint64())
	}
}

// Once price falls through the trail the order settles rather than tracking.
func TestHandler_TrailingFiresOnReversal(t *testing.T) {
	terms := encodeTermsTrailing(t, 500, uint64(now.Unix())+3600)
	h, cleanup := harness(t, terms, big.NewInt(1_000_000)) // $1, far under the peak
	defer cleanup()

	out := h.Evaluate(context.Background(), encodeInstructionPeak(t, 1, wraithAddr, []byte("cipher"), e18Big(10)))

	if out.Status != 1 || len(out.Data) == 0 {
		t.Fatalf("expected a settlement, got status %d len %d (%s)", out.Status, len(out.Data), out.Log)
	}
	action := new(big.Int).SetBytes(out.Data[2*32 : 3*32])
	if action.Uint64() == uint64(trigger.ActionTrack) {
		t.Fatal("a reversal through the trail must settle, not track")
	}
}

func e18Big(n int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(n), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
}

// encodeTermsTrailing seals a trailing stop with the given trail distance.
func encodeTermsTrailing(t *testing.T, trailBIPS uint64, expiry uint64) []byte {
	t.Helper()
	return encodeTermsAll(t, "below", big.NewInt(0), 0, expiry, big.NewInt(0), 2, zeroAddr, 0, trailBIPS)
}

// A TWAP order must survive the wire, or the enclave would judge it as a price
// order against an empty feed and never release a chunk.
func TestDecodeTerms_RoundTripsATWAPOrder(t *testing.T) {
	seed := [32]byte{7, 7, 7}

	got, err := DecodeTerms(encodeTermsTWAP(
		t, "below", big.NewInt(0), 0, 99999, big.NewInt(0), 3, zeroAddr, 0, 0, seed, 6, 1000, 5000,
	))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got.Kind != trigger.KindTWAP {
		t.Errorf("kind = %d, want KindTWAP", got.Kind)
	}
	if got.Seed != seed {
		t.Errorf("seed = %x, want %x", got.Seed, seed)
	}
	if got.Chunks != 6 || got.StartAt != 1000 || got.EndAt != 5000 {
		t.Errorf("schedule = %d chunks over %d-%d, want 6 over 1000-5000", got.Chunks, got.StartAt, got.EndAt)
	}
}

// The settlement result must carry the chunk size, or the contract spends the
// whole escrow on the first release and the TWAP becomes a single shot.
func TestEncodeResult_CarriesTheChunkAmount(t *testing.T) {
	terms := &trigger.Terms{
		Contract:     wraithAddr,
		Kind:         trigger.KindTWAP,
		Action:       trigger.ActionSwap,
		MinOutOrLots: big.NewInt(1),
		TokenOut:     tokenOut,
	}

	chunk := big.NewInt(25)
	data, err := EncodeResult(1, wraithAddr, terms, nil, chunk)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// chunkAmount is head word 7.
	got := new(big.Int).SetBytes(data[7*32 : 8*32])
	if got.Cmp(chunk) != 0 {
		t.Fatalf("chunk = %s, want %s", got, chunk)
	}
}
