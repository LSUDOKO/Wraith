// Package trigger evaluates a decrypted order's private condition.
//
// This is the only place the plaintext of an order exists, and it exists only
// inside the enclave. Everything here is deliberately dependency-free and pure
// so the decision logic can be tested directly.
package trigger

import (
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// Direction is which side of the threshold fires the order.
type Direction string

const (
	// Below fires when the price falls to or through the threshold — a stop-loss.
	Below Direction = "below"
	// Above fires when the price rises to or through the threshold — a take-profit.
	Above Direction = "above"
)

// Kind selects which secret an order carries and therefore how it is judged.
// Keeping the two apart matters: a price order and a shield populate different
// fields, and evaluating one as the other would read uninitialised state.
type Kind uint8

const (
	// KindPrice is a threshold against an FTSO feed. Zero value, so existing
	// sealed orders keep their meaning.
	KindPrice Kind = 0
	// KindAgentHealth watches a FAssets agent's collateral and status.
	KindAgentHealth Kind = 1
	// KindTrailing follows the price up and fires a set distance below the peak.
	KindTrailing Kind = 2
)

// AgentStatus mirrors AgentInfo.Status in the FAssets AssetManager.
type AgentStatus uint8

const (
	AgentNormal AgentStatus = iota
	AgentCCB
	AgentLiquidation
	AgentFullLiquidation
	AgentDestroying
)

// distressed reports whether a status is anything other than healthy. CCB
// (collateral call band) already means the agent is under-collateralised and
// on a countdown, so it counts.
func (s AgentStatus) distressed() bool { return s != AgentNormal }

// AgentHealth is a reading of one FAssets agent, as returned by
// AssetManager.getAgentInfo. Ratios are in BIPS, where 10000 is 100%.
type AgentHealth struct {
	Status      AgentStatus
	VaultCRBIPS uint64
	PoolCRBIPS  uint64
}

// Action mirrors the ACTION_* constants in WraithOrders.sol.
type Action uint8

const (
	ActionSwap   Action = 0
	ActionRedeem Action = 1
	// ActionTrack records a new peak without settling, mirroring
	// WraithOrders.ACTION_TRACK.
	ActionTrack Action = 2
)

// scale is the fixed-point scale (1e18) that thresholds and normalized prices
// share, so a threshold is comparable to any feed regardless of its decimals.
const scale = 18

// maxExponent bounds decimal normalization. FTSO decimals are an int8, so a
// hostile or corrupt value could otherwise ask for an astronomically large
// big.Int allocation.
const maxExponent = 60

// Terms is the plaintext of an order: the secret the whole system protects.
// It never leaves the enclave.
type Terms struct {
	// Kind decides which of the condition fields below are meaningful.
	Kind Kind

	// --- KindAgentHealth ---

	// Agent is the FAssets agent vault being watched.
	Agent string
	// MinCollateralBIPS fires the escape when either the vault or pool
	// collateral ratio falls to or below it. 12000 is 120%.
	MinCollateralBIPS uint64

	// --- KindTrailing ---

	// TrailBIPS is how far below the running peak the stop sits. 500 is 5%.
	// This is the secret a public trailing stop would leak: knowing the peak
	// tells an observer nothing without it.
	TrailBIPS uint64

	OrderID  uint64
	Contract string // Wraith deployment this order belongs to, "0x…"
	FeedID   string // FTSO feed id, e.g. "0x01464c522f55534400000000000000000000000000"

	Direction    Direction
	ThresholdE18 *big.Int // trigger price, scaled by 1e18

	// SecondThresholdE18 turns the order into a bracket (OCO): the opposite
	// side of Direction also fires. A stop-loss at 2 with this set to 5 fires
	// below 2 or above 5, and whichever hits first settles the order — the
	// contract's executed flag kills the other leg, so no cancellation is
	// needed. Nil means a plain single-leg order.
	SecondThresholdE18 *big.Int

	Action            Action
	MinOutOrLots      *big.Int // swap: minimum output; redeem: lot count
	TokenOut          string   // swap only
	UnderlyingAddress string   // redeem only: XRPL r-address

	Expiry uint64 // unix seconds
}

// Observation is a price reading from FTSO, in the shape getFeedById returns:
// the true price is Value / 10^Decimals.
type Observation struct {
	Value    *big.Int
	Decimals int8
	Time     time.Time
}

// Decision is the outcome of evaluating one order.
type Decision struct {
	Fire bool
	// Reason is for enclave-local logging only. It describes the private terms,
	// so it must never be returned to the chain or to a caller.
	Reason string
}

var (
	ErrNilTerms        = errors.New("nil terms")
	ErrNilObservation  = errors.New("nil observation")
	ErrNoThreshold     = errors.New("terms missing threshold")
	ErrBadDirection    = errors.New("unknown direction")
	ErrBadAction       = errors.New("unknown action")
	ErrExpired         = errors.New("order expired")
	ErrStalePrice      = errors.New("price observation is stale")
	ErrBadDecimals     = errors.New("feed decimals out of range")
	ErrContractMissing = errors.New("terms missing contract address")
	ErrBadRedeem       = errors.New("redeem requires lots and an underlying address")
	ErrBadSwap         = errors.New("swap requires a positive minimum output and a token out")
	ErrBadBracket      = errors.New("bracket legs overlap: the take-profit must sit beyond the stop")
	ErrBadShield       = errors.New("shield requires an agent and a sane collateral threshold")
	ErrNoAgentHealth   = errors.New("no agent health reading")
	ErrWrongKind       = errors.New("order evaluated against the wrong condition kind")
	ErrBadTrail        = errors.New("trail distance must be above zero and below 100%")
)

// bipsDenominator is 100% expressed in basis points.
const bipsDenominator = 10_000

// maxCollateralBIPS bounds the shield threshold. Agents can legitimately sit in
// the thousands of percent, but a threshold beyond 100000% is a malformed order
// rather than an ambitious one.
const maxCollateralBIPS = 10_000_000

// Validate reports whether the decrypted terms are internally coherent. It is
// separate from Evaluate so a malformed order is rejected once, on decrypt,
// rather than silently never firing.
func (t *Terms) Validate() error {
	if t == nil {
		return ErrNilTerms
	}
	if strings.TrimSpace(t.Contract) == "" {
		return ErrContractMissing
	}
	if t.Kind == KindTrailing {
		// A trail of 0 never fires; a trail of 100% or more puts the stop at or
		// below zero, which also never fires. Both are malformed rather than
		// merely useless, so they are rejected at seal time.
		if t.TrailBIPS == 0 || t.TrailBIPS >= bipsDenominator {
			return ErrBadTrail
		}
		return t.validateAction()
	}

	if t.Kind == KindAgentHealth {
		if strings.TrimSpace(t.Agent) == "" ||
			t.MinCollateralBIPS == 0 ||
			t.MinCollateralBIPS > maxCollateralBIPS {
			return ErrBadShield
		}
		return t.validateAction()
	}

	if t.ThresholdE18 == nil || t.ThresholdE18.Sign() <= 0 {
		return ErrNoThreshold
	}
	if t.Direction != Below && t.Direction != Above {
		return fmt.Errorf("%w: %q", ErrBadDirection, t.Direction)
	}

	if t.SecondThresholdE18 != nil {
		if t.SecondThresholdE18.Sign() <= 0 {
			return ErrNoThreshold
		}
		// The second leg fires on the opposite side, so it must sit beyond the
		// first. Overlapping legs would fire at any price at all.
		beyond := t.SecondThresholdE18.Cmp(t.ThresholdE18) > 0
		if t.Direction == Above {
			beyond = t.SecondThresholdE18.Cmp(t.ThresholdE18) < 0
		}
		if !beyond {
			return fmt.Errorf("%w: stop %s, take-profit %s", ErrBadBracket, t.ThresholdE18, t.SecondThresholdE18)
		}
	}

	return t.validateAction()
}

// validateAction checks the settlement half of an order, which every kind
// shares.
func (t *Terms) validateAction() error {
	switch t.Action {
	case ActionSwap:
		if t.MinOutOrLots == nil || t.MinOutOrLots.Sign() <= 0 || strings.TrimSpace(t.TokenOut) == "" {
			return ErrBadSwap
		}
	case ActionRedeem:
		if t.MinOutOrLots == nil || t.MinOutOrLots.Sign() <= 0 || strings.TrimSpace(t.UnderlyingAddress) == "" {
			return ErrBadRedeem
		}
	default:
		return fmt.Errorf("%w: %d", ErrBadAction, t.Action)
	}

	return nil
}

// TrailingDecision is a Decision plus the peak the caller should persist.
type TrailingDecision struct {
	Decision
	// NewPeakE18 is the peak after this observation. The caller writes it back
	// on-chain; the enclave keeps nothing between ticks.
	NewPeakE18 *big.Int
}

// EvaluateTrailing follows the price up and fires a sealed distance below the
// running peak.
//
// The peak arrives from on-chain rather than from memory, because the enclave
// has no storage that survives a restart. That is sound: the peak is derived
// from public FTSO prices, so publishing it reveals nothing an observer could
// not compute. The trail distance never leaves the ciphertext, and without it
// the peak says nothing about where the order fires.
func EvaluateTrailing(t *Terms, obs *Observation, peakE18 *big.Int, now time.Time) (TrailingDecision, error) {
	if t == nil {
		return TrailingDecision{}, ErrNilTerms
	}
	if t.Kind != KindTrailing {
		return TrailingDecision{}, fmt.Errorf("%w: want trailing, got kind %d", ErrWrongKind, t.Kind)
	}
	if err := t.Validate(); err != nil {
		return TrailingDecision{}, err
	}
	if obs == nil || obs.Value == nil {
		return TrailingDecision{}, ErrNilObservation
	}
	if t.Expiry != 0 && uint64(now.Unix()) >= t.Expiry {
		return TrailingDecision{}, ErrExpired
	}

	age := now.Sub(obs.Time)
	if age < 0 {
		age = -age
	}
	if age > maxPriceAge {
		return TrailingDecision{}, fmt.Errorf("%w: %s old", ErrStalePrice, age)
	}

	priceE18, err := NormalizeE18(obs.Value, obs.Decimals)
	if err != nil {
		return TrailingDecision{}, err
	}

	peak := peakE18
	if peak == nil {
		peak = big.NewInt(0)
	}

	// The high-water mark only ratchets up. A dip must not drag the trail down
	// with it, or the stop fires on noise rather than on a real reversal.
	newPeak := new(big.Int).Set(peak)
	if priceE18.Cmp(newPeak) > 0 {
		newPeak.Set(priceE18)
	}

	// stop = peak * (10000 - trail) / 10000
	stop := new(big.Int).Mul(newPeak, big.NewInt(int64(bipsDenominator-t.TrailBIPS)))
	stop.Quo(stop, big.NewInt(bipsDenominator))

	// A brand new order has no peak yet, so there is nothing to trail from and
	// this tick only establishes the mark.
	fire := newPeak.Sign() > 0 && priceE18.Cmp(stop) <= 0

	return TrailingDecision{
		Decision: Decision{
			Fire:   fire,
			Reason: fmt.Sprintf("price %s vs stop %s (peak %s, trail %d bips)", priceE18, stop, newPeak, t.TrailBIPS),
		},
		NewPeakE18: newPeak,
	}, nil
}

// EvaluateAgent decides whether a FAssets Shield should fire.
//
// It escapes on either of two conditions: the agent has left NORMAL status, or
// its collateral has fallen to the sealed threshold. The status check is
// deliberately independent of the ratios — once an agent is in liquidation the
// ratio it reports is no longer the thing that matters.
func EvaluateAgent(t *Terms, health *AgentHealth, now time.Time) (Decision, error) {
	if t == nil {
		return Decision{}, ErrNilTerms
	}
	if t.Kind != KindAgentHealth {
		return Decision{}, fmt.Errorf("%w: want agent health, got kind %d", ErrWrongKind, t.Kind)
	}
	if err := t.Validate(); err != nil {
		return Decision{}, err
	}
	if health == nil {
		return Decision{}, ErrNoAgentHealth
	}
	if t.Expiry != 0 && uint64(now.Unix()) >= t.Expiry {
		return Decision{}, ErrExpired
	}

	if health.Status.distressed() {
		return Decision{
			Fire:   true,
			Reason: fmt.Sprintf("agent status %d is not normal", health.Status),
		}, nil
	}

	// Either leg of the collateral falling is enough: a healthy vault does not
	// protect a minter whose pool side is collapsing, and the reverse holds too.
	breached := health.VaultCRBIPS <= t.MinCollateralBIPS || health.PoolCRBIPS <= t.MinCollateralBIPS

	return Decision{
		Fire: breached,
		Reason: fmt.Sprintf(
			"vault %d / pool %d bips vs floor %d",
			health.VaultCRBIPS, health.PoolCRBIPS, t.MinCollateralBIPS,
		),
	}, nil
}

// Evaluate decides whether an order's condition has fired.
//
// It returns an error rather than a false Decision when it cannot answer
// safely — expired, stale, or malformed. The caller reports those as a failed
// action, which the contract will not settle.
func Evaluate(t *Terms, obs *Observation, now time.Time) (Decision, error) {
	if t != nil && t.Kind != KindPrice {
		return Decision{}, fmt.Errorf("%w: want price, got kind %d", ErrWrongKind, t.Kind)
	}
	if err := t.Validate(); err != nil {
		return Decision{}, err
	}
	if obs == nil || obs.Value == nil {
		return Decision{}, ErrNilObservation
	}

	if t.Expiry != 0 && uint64(now.Unix()) >= t.Expiry {
		return Decision{}, ErrExpired
	}

	age := now.Sub(obs.Time)
	if age < 0 {
		age = -age
	}
	if age > maxPriceAge {
		return Decision{}, fmt.Errorf("%w: %s old", ErrStalePrice, age)
	}

	priceE18, err := NormalizeE18(obs.Value, obs.Decimals)
	if err != nil {
		return Decision{}, err
	}

	cmp := priceE18.Cmp(t.ThresholdE18)

	// Both boundaries are inclusive: a stop set at exactly the traded price
	// should fire, which is what a trader expects from "stop at X".
	var fire bool
	switch t.Direction {
	case Below:
		fire = cmp <= 0
	case Above:
		fire = cmp >= 0
	default:
		return Decision{}, fmt.Errorf("%w: %q", ErrBadDirection, t.Direction)
	}

	// The bracket's opposite leg.
	if !fire && t.SecondThresholdE18 != nil {
		second := priceE18.Cmp(t.SecondThresholdE18)
		if t.Direction == Below {
			fire = second >= 0 // stop below, take-profit above
		} else {
			fire = second <= 0 // take-profit above, stop below
		}
	}

	return Decision{
		Fire:   fire,
		Reason: fmt.Sprintf("price %s vs threshold %s (%s)", priceE18, t.ThresholdE18, t.Direction),
	}, nil
}

// maxPriceAge is a package-level variable only so tests can narrow it; production
// callers get the config default.
var maxPriceAge = 2 * time.Minute

// SetMaxPriceAge overrides the staleness bound. Intended for wiring from config
// at startup, not for changing mid-flight.
func SetMaxPriceAge(d time.Duration) {
	if d > 0 {
		maxPriceAge = d
	}
}

// NormalizeE18 converts a raw FTSO reading to a 1e18-scaled integer, so feeds
// with different decimals compare against one threshold scale.
//
// Down-scaling (decimals > 18) truncates. That loses sub-1e-18 precision, which
// no feed carries, so it cannot change a comparison in practice.
func NormalizeE18(value *big.Int, decimals int8) (*big.Int, error) {
	if value == nil {
		return nil, ErrNilObservation
	}

	exp := int(scale) - int(decimals)
	if exp > maxExponent || exp < -maxExponent {
		return nil, fmt.Errorf("%w: %d", ErrBadDecimals, decimals)
	}

	out := new(big.Int).Set(value)
	if exp == 0 {
		return out, nil
	}

	if exp > 0 {
		factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(exp)), nil)
		return out.Mul(out, factor), nil
	}

	factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(-exp)), nil)
	return out.Quo(out, factor), nil
}
