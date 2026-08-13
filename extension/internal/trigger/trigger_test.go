package trigger

import (
	"errors"
	"math/big"
	"testing"
	"time"
)

var now = time.Unix(1_000_000, 0)

func e18(n int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(n), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
}

// validTerms is a stop-loss: sell if FXRP falls to $2.00 or below.
func validTerms() *Terms {
	return &Terms{
		OrderID:      1,
		Contract:     "0x00000000000000000000000000000000000000aa",
		FeedID:       "0x01464c522f55534400000000000000000000000000",
		Direction:    Below,
		ThresholdE18: e18(2),
		Action:       ActionSwap,
		MinOutOrLots: big.NewInt(1),
		TokenOut:     "0x00000000000000000000000000000000000000bb",
		Expiry:       uint64(now.Unix()) + 3600,
	}
}

// obs builds a reading of `price` dollars at `decimals` precision.
func obs(price int64, decimals int8, t time.Time) *Observation {
	v := new(big.Int).Mul(big.NewInt(price), new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	return &Observation{Value: v, Decimals: decimals, Time: t}
}

func TestEvaluate_StopLossFiresAtOrBelowThreshold(t *testing.T) {
	tests := []struct {
		name  string
		price int64
		want  bool
	}{
		{"well above threshold", 5, false},
		{"just above threshold", 3, false},
		{"exactly at threshold", 2, true},
		{"below threshold", 1, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Evaluate(validTerms(), obs(tc.price, 6, now), now)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Fire != tc.want {
				t.Errorf("price %d vs threshold 2: Fire = %v, want %v", tc.price, got.Fire, tc.want)
			}
		})
	}
}

func TestEvaluate_TakeProfitFiresAtOrAboveThreshold(t *testing.T) {
	tests := []struct {
		name  string
		price int64
		want  bool
	}{
		{"below threshold", 1, false},
		{"exactly at threshold", 2, true},
		{"above threshold", 9, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			terms := validTerms()
			terms.Direction = Above

			got, err := Evaluate(terms, obs(tc.price, 6, now), now)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Fire != tc.want {
				t.Errorf("price %d vs threshold 2: Fire = %v, want %v", tc.price, got.Fire, tc.want)
			}
		})
	}
}

// A feed's decimals must not change the decision.
func TestEvaluate_DecisionIsIndependentOfFeedDecimals(t *testing.T) {
	for _, decimals := range []int8{0, 2, 6, 8, 18} {
		got, err := Evaluate(validTerms(), obs(1, decimals, now), now)
		if err != nil {
			t.Fatalf("decimals %d: unexpected error: %v", decimals, err)
		}
		if !got.Fire {
			t.Errorf("decimals %d: price 1 is below threshold 2, expected fire", decimals)
		}
	}
}

func TestEvaluate_RejectsExpiredOrder(t *testing.T) {
	terms := validTerms()
	terms.Expiry = uint64(now.Unix())

	_, err := Evaluate(terms, obs(1, 6, now), now)
	if !errors.Is(err, ErrExpired) {
		t.Fatalf("got %v, want ErrExpired", err)
	}
}

// An irreversible trade must not fire on a stale price. Missing a tick is cheap;
// the keeper ticks again seconds later.
func TestEvaluate_RejectsStalePrice(t *testing.T) {
	stale := now.Add(-maxPriceAge - time.Second)

	_, err := Evaluate(validTerms(), obs(1, 6, stale), now)
	if !errors.Is(err, ErrStalePrice) {
		t.Fatalf("got %v, want ErrStalePrice", err)
	}
}

func TestEvaluate_AcceptsPriceWithinStalenessWindow(t *testing.T) {
	fresh := now.Add(-maxPriceAge + time.Second)

	if _, err := Evaluate(validTerms(), obs(1, 6, fresh), now); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestEvaluate_RejectsNilObservation(t *testing.T) {
	if _, err := Evaluate(validTerms(), nil, now); !errors.Is(err, ErrNilObservation) {
		t.Fatalf("got %v, want ErrNilObservation", err)
	}
}

func TestValidate_RejectsMalformedTerms(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*Terms)
		wantErr error
	}{
		{"missing contract", func(tm *Terms) { tm.Contract = "" }, ErrContractMissing},
		{"nil threshold", func(tm *Terms) { tm.ThresholdE18 = nil }, ErrNoThreshold},
		{"zero threshold", func(tm *Terms) { tm.ThresholdE18 = big.NewInt(0) }, ErrNoThreshold},
		{"negative threshold", func(tm *Terms) { tm.ThresholdE18 = big.NewInt(-1) }, ErrNoThreshold},
		{"unknown direction", func(tm *Terms) { tm.Direction = "sideways" }, ErrBadDirection},
		{"unknown action", func(tm *Terms) { tm.Action = Action(9) }, ErrBadAction},
		{"swap without tokenOut", func(tm *Terms) { tm.TokenOut = "" }, ErrBadSwap},
		{"swap without minimum output", func(tm *Terms) { tm.MinOutOrLots = big.NewInt(0) }, ErrBadSwap},
		{
			"redeem without underlying address",
			func(tm *Terms) { tm.Action = ActionRedeem; tm.UnderlyingAddress = "" },
			ErrBadRedeem,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			terms := validTerms()
			tc.mutate(terms)

			if err := terms.Validate(); !errors.Is(err, tc.wantErr) {
				t.Fatalf("got %v, want %v", err, tc.wantErr)
			}
			// Malformed terms must fail evaluation too, not merely validation.
			if _, err := Evaluate(terms, obs(1, 6, now), now); err == nil {
				t.Fatal("Evaluate accepted malformed terms")
			}
		})
	}
}

func TestValidate_AcceptsWellFormedRedeem(t *testing.T) {
	terms := validTerms()
	terms.Action = ActionRedeem
	terms.MinOutOrLots = big.NewInt(3)
	terms.UnderlyingAddress = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"
	terms.TokenOut = ""

	if err := terms.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNormalizeE18(t *testing.T) {
	tests := []struct {
		name     string
		value    *big.Int
		decimals int8
		want     *big.Int
	}{
		{"already 1e18", e18(7), 18, e18(7)},
		{"six decimals scales up", big.NewInt(7_000_000), 6, e18(7)},
		{"zero decimals scales up", big.NewInt(7), 0, e18(7)},
		{"negative decimals scale further up", big.NewInt(7), -2, new(big.Int).Mul(e18(7), big.NewInt(100))},
		{"more than 18 decimals truncates down", new(big.Int).Mul(e18(7), big.NewInt(100)), 20, e18(7)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeE18(tc.value, tc.decimals)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Cmp(tc.want) != 0 {
				t.Errorf("got %s, want %s", got, tc.want)
			}
		})
	}
}

// A corrupt decimals value must not induce a huge allocation.
func TestNormalizeE18_RejectsOutOfRangeDecimals(t *testing.T) {
	for _, decimals := range []int8{-127, 127} {
		if _, err := NormalizeE18(big.NewInt(1), decimals); !errors.Is(err, ErrBadDecimals) {
			t.Errorf("decimals %d: got %v, want ErrBadDecimals", decimals, err)
		}
	}
}

func TestNormalizeE18_DoesNotMutateInput(t *testing.T) {
	value := big.NewInt(7_000_000)
	original := new(big.Int).Set(value)

	if _, err := NormalizeE18(value, 6); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if value.Cmp(original) != 0 {
		t.Fatalf("input mutated: got %s, want %s", value, original)
	}
}

// --- OCO (bracket) orders ---
//
// A bracket is a stop and a take-profit sharing one escrow. Whichever side hits
// first settles the order, and the contract's executed flag kills the other leg
// for free — so this needs no second order and no contract change.

// bracket returns a stop-loss at $2 with a take-profit at $5.
func bracketTerms() *Terms {
	t := validTerms()
	t.Direction = Below
	t.ThresholdE18 = e18(2)
	t.SecondThresholdE18 = e18(5)
	return t
}

func TestEvaluate_BracketFiresOnEitherLeg(t *testing.T) {
	tests := []struct {
		name  string
		price int64
		want  bool
	}{
		{"below the stop", 1, true},
		{"exactly at the stop", 2, true},
		{"between the legs, nothing fires", 3, false},
		{"exactly at the take-profit", 5, true},
		{"above the take-profit", 9, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Evaluate(bracketTerms(), obs(tc.price, 6, now), now)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Fire != tc.want {
				t.Errorf("price %d with stop 2 / take-profit 5: Fire = %v, want %v", tc.price, got.Fire, tc.want)
			}
		})
	}
}

// The take-profit on a stop-loss bracket must sit above the stop, otherwise the
// two legs overlap and the order would fire immediately at any price.
func TestValidate_RejectsInvertedBracket(t *testing.T) {
	terms := bracketTerms()
	terms.SecondThresholdE18 = e18(1) // below the stop at 2

	if err := terms.Validate(); !errors.Is(err, ErrBadBracket) {
		t.Fatalf("got %v, want ErrBadBracket", err)
	}
}

func TestValidate_RejectsInvertedBracketOnTakeProfitOrders(t *testing.T) {
	terms := bracketTerms()
	terms.Direction = Above
	terms.ThresholdE18 = e18(5)
	terms.SecondThresholdE18 = e18(9) // stop must sit below a take-profit primary

	if err := terms.Validate(); !errors.Is(err, ErrBadBracket) {
		t.Fatalf("got %v, want ErrBadBracket", err)
	}
}

// A plain single-leg order must behave exactly as before.
func TestEvaluate_SingleLegUnaffectedByBracketSupport(t *testing.T) {
	terms := validTerms() // no SecondThresholdE18
	if terms.SecondThresholdE18 != nil {
		t.Fatal("single-leg orders must leave the second threshold unset")
	}

	fired, err := Evaluate(terms, obs(1, 6, now), now)
	if err != nil || !fired.Fire {
		t.Fatalf("stop should fire below threshold: %v %v", fired.Fire, err)
	}

	quiet, err := Evaluate(terms, obs(9, 6, now), now)
	if err != nil || quiet.Fire {
		t.Fatalf("stop must not fire far above threshold: %v %v", quiet.Fire, err)
	}
}

// --- FAssets Shield: agent-health triggers ---
//
// A FAssets minter is exposed to their agent defaulting. Today they watch a
// dashboard; if they sleep through a collateral-ratio slide they face a delayed
// redemption or a liquidation cascade. Shield fires an escape automatically,
// and because the threshold is sealed nobody can position against the exit.

func shieldTerms() *Terms {
	t := validTerms()
	t.Kind = KindAgentHealth
	t.Agent = "0x55c815260cbe6c45fe5bfe5ff32e3c7d746f14dc"
	t.MinCollateralBIPS = 12_000 // 120%
	return t
}

// A healthy agent must not trigger an escape.
func TestEvaluateAgent_QuietWhileHealthy(t *testing.T) {
	got, err := EvaluateAgent(shieldTerms(), &AgentHealth{Status: AgentNormal, VaultCRBIPS: 54_599, PoolCRBIPS: 80_697}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Fire {
		t.Error("healthy agent at 545% must not fire a 120% shield")
	}
}

func TestEvaluateAgent_FiresWhenCollateralFalls(t *testing.T) {
	tests := []struct {
		name  string
		vault uint64
		pool  uint64
		want  bool
	}{
		{"comfortably above", 15_000, 15_000, false},
		{"vault exactly at the threshold", 12_000, 15_000, true},
		{"vault below", 11_500, 15_000, true},
		{"pool below even though vault is fine", 30_000, 11_000, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := EvaluateAgent(
				shieldTerms(),
				&AgentHealth{Status: AgentNormal, VaultCRBIPS: tc.vault, PoolCRBIPS: tc.pool},
				now,
			)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Fire != tc.want {
				t.Errorf("vault %d pool %d: Fire = %v, want %v", tc.vault, tc.pool, got.Fire, tc.want)
			}
		})
	}
}

// Liquidation is the emergency the whole feature exists for: escape regardless
// of what the ratios currently read.
func TestEvaluateAgent_FiresOnLiquidationAtAnyRatio(t *testing.T) {
	for _, status := range []AgentStatus{AgentCCB, AgentLiquidation, AgentFullLiquidation, AgentDestroying} {
		got, err := EvaluateAgent(
			shieldTerms(),
			&AgentHealth{Status: status, VaultCRBIPS: 90_000, PoolCRBIPS: 90_000},
			now,
		)
		if err != nil {
			t.Fatalf("status %d: unexpected error: %v", status, err)
		}
		if !got.Fire {
			t.Errorf("status %d must fire even at 900%% collateral", status)
		}
	}
}

func TestEvaluateAgent_RejectsExpiredShield(t *testing.T) {
	terms := shieldTerms()
	terms.Expiry = uint64(now.Unix())

	if _, err := EvaluateAgent(terms, &AgentHealth{Status: AgentNormal, VaultCRBIPS: 1}, now); !errors.Is(err, ErrExpired) {
		t.Fatalf("got %v, want ErrExpired", err)
	}
}

func TestEvaluateAgent_RejectsMissingHealth(t *testing.T) {
	if _, err := EvaluateAgent(shieldTerms(), nil, now); !errors.Is(err, ErrNoAgentHealth) {
		t.Fatalf("got %v, want ErrNoAgentHealth", err)
	}
}

func TestValidate_RejectsShieldWithoutAgentOrThreshold(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Terms)
	}{
		{"no agent", func(t *Terms) { t.Agent = "" }},
		{"no threshold", func(t *Terms) { t.MinCollateralBIPS = 0 }},
		{"absurd threshold", func(t *Terms) { t.MinCollateralBIPS = 10_000_001 }},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			terms := shieldTerms()
			tc.mutate(terms)
			if err := terms.Validate(); !errors.Is(err, ErrBadShield) {
				t.Fatalf("got %v, want ErrBadShield", err)
			}
		})
	}
}

// A price order must not be evaluated as a shield, or vice versa — the two
// carry different secrets and mixing them would read uninitialised fields.
func TestEvaluate_RefusesToEvaluateAShieldAsAPriceOrder(t *testing.T) {
	if _, err := Evaluate(shieldTerms(), obs(1, 6, now), now); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("got %v, want ErrWrongKind", err)
	}
	if _, err := EvaluateAgent(validTerms(), &AgentHealth{Status: AgentNormal}, now); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("got %v, want ErrWrongKind", err)
	}
}

// --- Trailing stops ---
//
// The trail follows price up and never back down. The peak lives on-chain
// because the enclave has no storage, which is safe: the peak is derived from
// public FTSO prices. The trail *distance* is the secret and stays sealed.

func trailingTerms() *Terms {
	t := validTerms()
	t.Kind = KindTrailing
	t.TrailBIPS = 500 // 5% below the peak
	t.ThresholdE18 = nil
	return t
}

func TestEvaluateTrailing_TracksUpAndFiresOnTheWayDown(t *testing.T) {
	tests := []struct {
		name     string
		peak     int64
		price    int64
		wantFire bool
		wantPeak int64
	}{
		{"first reading sets the peak", 0, 100, false, 100},
		{"new high raises the peak", 100, 120, false, 120},
		{"small dip inside the trail holds", 100, 96, false, 100},
		{"exactly on the trail fires", 100, 95, true, 100},
		{"through the trail fires", 100, 90, true, 100},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := EvaluateTrailing(trailingTerms(), obs(tc.price, 6, now), e18(tc.peak), now)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Fire != tc.wantFire {
				t.Errorf("peak %d price %d: Fire = %v, want %v", tc.peak, tc.price, got.Fire, tc.wantFire)
			}
			if got.NewPeakE18.Cmp(e18(tc.wantPeak)) != 0 {
				t.Errorf("peak = %s, want %s", got.NewPeakE18, e18(tc.wantPeak))
			}
		})
	}
}

// A dip must never lower the peak, or the trail walks down with the price and
// the stop fires on noise.
func TestEvaluateTrailing_PeakNeverFalls(t *testing.T) {
	got, err := EvaluateTrailing(trailingTerms(), obs(50, 6, now), e18(100), now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.NewPeakE18.Cmp(e18(100)) != 0 {
		t.Fatalf("peak fell to %s", got.NewPeakE18)
	}
}

func TestValidate_RejectsImpossibleTrail(t *testing.T) {
	for _, bips := range []uint64{0, 10_000, 20_000} {
		terms := trailingTerms()
		terms.TrailBIPS = bips
		if err := terms.Validate(); !errors.Is(err, ErrBadTrail) {
			t.Errorf("trail %d bips: got %v, want ErrBadTrail", bips, err)
		}
	}
}

func TestEvaluateTrailing_RefusesAPriceOrder(t *testing.T) {
	if _, err := EvaluateTrailing(validTerms(), obs(1, 6, now), e18(1), now); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("got %v, want ErrWrongKind", err)
	}
}

func TestEvaluateTrailing_RejectsStalePrice(t *testing.T) {
	stale := now.Add(-maxPriceAge - time.Second)
	if _, err := EvaluateTrailing(trailingTerms(), obs(90, 6, stale), e18(100), now); !errors.Is(err, ErrStalePrice) {
		t.Fatalf("got %v, want ErrStalePrice", err)
	}
}

// --- Stealth TWAP ---
//
// A large sell executed at once moves the market and announces its size. TWAP
// splits it into chunks at randomized times and sizes.
//
// The schedule is *derived*, never stored: keccak(seed, index) gives the same
// jitter on every tick, so the enclave recomputes it identically without
// keeping state across restarts. The seed is sealed, so the schedule is secret
// even though the executions themselves are public — an observer sees chunks
// land but cannot tell how many remain or when the next one is due.

func twapTerms() *Terms {
	t := validTerms()
	t.Kind = KindTWAP
	t.ThresholdE18 = nil
	t.Seed = [32]byte{1, 2, 3, 4}
	t.Chunks = 4
	t.StartAt = uint64(now.Unix())
	t.EndAt = uint64(now.Unix()) + 3600
	t.Expiry = uint64(now.Unix()) + 7200
	return t
}

func TestEvaluateTWAP_ReleasesChunksAcrossTheWindow(t *testing.T) {
	terms := twapTerms()
	total := e18(100)

	// Nothing is due before the window opens.
	before, err := EvaluateTWAP(terms, total, total, now.Add(-time.Minute))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if before.Fire {
		t.Error("a TWAP must not release before its window opens")
	}

	// By the end of the window everything is due.
	after, err := EvaluateTWAP(terms, total, total, time.Unix(int64(terms.EndAt)+1, 0))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !after.Fire {
		t.Error("a TWAP must finish by the end of its window")
	}
}

// The same order judged at the same instant must always produce the same
// chunk. If it did not, a restart mid-schedule would double-spend or stall.
func TestEvaluateTWAP_ScheduleIsDeterministic(t *testing.T) {
	terms := twapTerms()
	total := e18(100)
	at := time.Unix(int64(terms.StartAt)+1800, 0)

	first, err := EvaluateTWAP(terms, total, total, at)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	second, err := EvaluateTWAP(terms, total, total, at)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if first.Fire != second.Fire || first.ChunkE18.Cmp(second.ChunkE18) != 0 {
		t.Fatalf("schedule is not deterministic: %v/%s then %v/%s",
			first.Fire, first.ChunkE18, second.Fire, second.ChunkE18)
	}
}

// A different seed must produce a different schedule, or the randomization is
// decorative and every order is front-runnable in the same way.
func TestEvaluateTWAP_SeedChangesTheSchedule(t *testing.T) {
	total := e18(100)
	at := time.Unix(int64(now.Unix())+900, 0)

	a := twapTerms()
	b := twapTerms()
	b.Seed = [32]byte{9, 9, 9, 9}

	da, err := EvaluateTWAP(a, total, total, at)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	db, err := EvaluateTWAP(b, total, total, at)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if da.ChunkE18.Cmp(db.ChunkE18) == 0 && da.Fire == db.Fire {
		t.Error("two seeds produced an identical release; the jitter is not seed-derived")
	}
}

// Chunks must never sum beyond the escrow, however the jitter falls.
func TestEvaluateTWAP_NeverReleasesMoreThanRemains(t *testing.T) {
	terms := twapTerms()
	total := e18(100)

	got, err := EvaluateTWAP(terms, total, e18(3), time.Unix(int64(terms.EndAt)+1, 0))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ChunkE18.Cmp(e18(3)) > 0 {
		t.Fatalf("chunk %s exceeds the remaining %s", got.ChunkE18, e18(3))
	}
}

func TestValidate_RejectsMalformedTWAP(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Terms)
	}{
		{"no chunks", func(t *Terms) { t.Chunks = 0 }},
		{"absurd chunk count", func(t *Terms) { t.Chunks = 1001 }},
		{"window ends before it starts", func(t *Terms) { t.EndAt = t.StartAt - 1 }},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			terms := twapTerms()
			tc.mutate(terms)
			if err := terms.Validate(); !errors.Is(err, ErrBadTWAP) {
				t.Fatalf("got %v, want ErrBadTWAP", err)
			}
		})
	}
}

// --- FDC cross-chain triggers ---
//
// FDC attests facts about other chains and about Web2 APIs. The proof cannot be
// fetched from inside the enclave — the TEE-based FDC is a Flare system app with
// no developer surface — so the keeper passes an already-verified observation in
// with the instruction.
//
// That makes the *observed fact* public, and it is: an XRPL payment landing is
// visible to anyone. What stays sealed is the threshold it is compared against,
// which is the part that would otherwise let someone trade ahead of the order.

func fdcTerms() *Terms {
	t := validTerms()
	t.Kind = KindCrossChain
	// A cross-chain order reuses the existing threshold and address fields:
	// the amount that fires it, and the XRPL source being watched.
	t.ThresholdE18 = e18(10_000)
	t.UnderlyingAddress = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"
	return t
}

func TestEvaluateCrossChain_FiresOnAttestedAmount(t *testing.T) {
	tests := []struct {
		name   string
		amount int64
		want   bool
	}{
		{"well under the threshold", 500, false},
		{"just under", 9_999, false},
		{"exactly at the threshold", 10_000, true},
		{"over", 50_000, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			att := &Attestation{
				Verified:  true,
				Source:    "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
				AmountE18: e18(tc.amount),
				At:        now,
			}
			got, err := EvaluateCrossChain(fdcTerms(), att, now)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Fire != tc.want {
				t.Errorf("amount %d vs threshold 10000: Fire = %v, want %v", tc.amount, got.Fire, tc.want)
			}
		})
	}
}

// An unverified attestation is just a claim from the keeper. Acting on one
// would let any keeper fire any cross-chain order at will.
func TestEvaluateCrossChain_RefusesUnverifiedAttestation(t *testing.T) {
	att := &Attestation{
		Verified:  false,
		Source:    "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
		AmountE18: e18(999_999),
		At:        now,
	}

	if _, err := EvaluateCrossChain(fdcTerms(), att, now); !errors.Is(err, ErrUnverified) {
		t.Fatalf("got %v, want ErrUnverified", err)
	}
}

// The attestation must concern the source the order actually named, or a
// payment to an unrelated address could trigger someone else's order.
func TestEvaluateCrossChain_RefusesAttestationForAnotherSource(t *testing.T) {
	att := &Attestation{
		Verified:  true,
		Source:    "rSomeoneElseEntirely1234567890abcd",
		AmountE18: e18(50_000),
		At:        now,
	}

	if _, err := EvaluateCrossChain(fdcTerms(), att, now); !errors.Is(err, ErrSourceMismatch) {
		t.Fatalf("got %v, want ErrSourceMismatch", err)
	}
}

func TestEvaluateCrossChain_RejectsStaleAttestation(t *testing.T) {
	att := &Attestation{
		Verified:  true,
		Source:    "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
		AmountE18: e18(50_000),
		At:        now.Add(-maxAttestationAge - time.Second),
	}

	if _, err := EvaluateCrossChain(fdcTerms(), att, now); !errors.Is(err, ErrStaleAttestation) {
		t.Fatalf("got %v, want ErrStaleAttestation", err)
	}
}

func TestValidate_RejectsMalformedCrossChain(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Terms)
	}{
		{"no source", func(t *Terms) { t.UnderlyingAddress = "" }},
		{"no threshold", func(t *Terms) { t.ThresholdE18 = nil }},
		{"zero threshold", func(t *Terms) { t.ThresholdE18 = big.NewInt(0) }},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			terms := fdcTerms()
			tc.mutate(terms)
			if err := terms.Validate(); !errors.Is(err, ErrBadCrossChain) {
				t.Fatalf("got %v, want ErrBadCrossChain", err)
			}
		})
	}
}

func TestEvaluateCrossChain_RefusesAPriceOrder(t *testing.T) {
	att := &Attestation{Verified: true, Source: "r", AmountE18: e18(1), At: now}
	if _, err := EvaluateCrossChain(validTerms(), att, now); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("got %v, want ErrWrongKind", err)
	}
}
