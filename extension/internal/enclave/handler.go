package enclave

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/LSUDOKO/Wraith/extension/internal/trigger"
)

// Handler evaluates one EVAL_ORDER instruction end to end: decode, decrypt,
// price, decide, and — only if the condition fired — build a settlement result.
type Handler struct {
	Decryptor *Decryptor
	Ftso      *FtsoReader
	// Agent reads FAssets agent health for Shield orders. Optional: without it
	// a Shield order fails rather than silently never firing.
	Agent *AgentReader
	// Now is split out for tests; defaults to time.Now.
	Now func() time.Time
}

// Outcome is what the extension harness turns into an ActionResult.
type Outcome struct {
	// Status 1 = success (fired or not), 0 = error. Mirrors ActionResult.Status.
	Status uint8
	// Data is the ABI-encoded settlement payload when the condition fired,
	// or empty for a no-op. Empty and fired are indistinguishable to
	// everyone outside the enclave until the result is relayed.
	Data []byte
	// Log is safe for enclave-local logs only. It must never describe the
	// terms when the order did not fire.
	Log string
}

// Evaluate handles one instruction message from WraithOrders.tick().
func (h *Handler) Evaluate(ctx context.Context, message []byte) Outcome {
	now := time.Now
	if h.Now != nil {
		now = h.Now
	}

	inst, err := DecodeInstruction(message)
	if err != nil {
		return Outcome{Status: 0, Log: fmt.Sprintf("bad instruction: %v", err)}
	}

	plaintext, err := h.Decryptor.Decrypt(ctx, inst.Ciphertext)
	if err != nil {
		return Outcome{Status: 0, Log: fmt.Sprintf("order %d: decrypt failed: %v", inst.OrderID, err)}
	}

	terms, err := DecodeTerms(plaintext)
	if err != nil {
		return Outcome{Status: 0, Log: fmt.Sprintf("order %d: bad terms: %v", inst.OrderID, err)}
	}

	// The sealed terms name the contract they were written for. Refusing a
	// mismatch stops a ciphertext from being replayed through a different
	// deployment's tick() to fish for results.
	if !strings.EqualFold(terms.Contract, inst.Contract) {
		return Outcome{Status: 0, Log: fmt.Sprintf("order %d: terms bound to a different contract", inst.OrderID)}
	}

	var decision trigger.Decision
	// newPeak is only meaningful for trailing stops; every other kind leaves it
	// nil and the contract keeps whatever peak it already had.
	var newPeak *big.Int
	// chunk is the slice of escrow a TWAP releases this tick; nil everywhere
	// else, which the contract reads as "spend the whole remainder".
	var chunk *big.Int

	switch terms.Kind {
	case trigger.KindAgentHealth:
		if h.Agent == nil {
			return Outcome{Status: 0, Log: fmt.Sprintf("order %d: shield orders need an agent reader", inst.OrderID)}
		}
		health, herr := h.Agent.Read(ctx, terms.Agent)
		if herr != nil {
			return Outcome{Status: 0, Log: fmt.Sprintf("order %d: agent read failed: %v", inst.OrderID, herr)}
		}
		decision, err = trigger.EvaluateAgent(terms, health, now())

	case trigger.KindTWAP:
		// Progress comes from what the contract says is left, not from memory —
		// which is what makes a chunked order survive an enclave restart.
		total := inst.RemainingE18
		twap, terr := trigger.EvaluateTWAP(terms, total, inst.RemainingE18, now())
		if terr != nil {
			err = terr
		} else {
			decision, chunk = twap.Decision, twap.ChunkE18
		}

	case trigger.KindTrailing:
		obs, oerr := h.Ftso.Read(ctx, terms.FeedID)
		if oerr != nil {
			return Outcome{Status: 0, Log: fmt.Sprintf("order %d: price read failed: %v", inst.OrderID, oerr)}
		}
		trailing, terr := trigger.EvaluateTrailing(terms, obs, inst.PeakE18, now())
		if terr != nil {
			err = terr
		} else {
			decision, newPeak = trailing.Decision, trailing.NewPeakE18
		}

	case trigger.KindCrossChain:
		// FDC is a Flare system application with no interface the enclave can
		// call, so the proof is verified on-chain and relayed in. No proof means
		// no answer — refusing is the only safe reply, since firing would mean
		// trusting the keeper.
		if inst.Attestation == nil {
			return Outcome{Status: 0, Log: fmt.Sprintf(
				"order %d: cross-chain orders need an attested tick", inst.OrderID)}
		}
		decision, err = trigger.EvaluateCrossChain(terms, inst.Attestation, now())

	case trigger.KindConsensus:
		if inst.Attestation == nil {
			return Outcome{Status: 0, Log: fmt.Sprintf(
				"order %d: consensus orders need a second attested oracle", inst.OrderID)}
		}
		obs, oerr := h.Ftso.Read(ctx, terms.FeedID)
		if oerr != nil {
			return Outcome{Status: 0, Log: fmt.Sprintf("order %d: price read failed: %v", inst.OrderID, oerr)}
		}
		decision, err = trigger.EvaluateConsensus(terms, obs, inst.Attestation, now())

	default:
		obs, oerr := h.Ftso.Read(ctx, terms.FeedID)
		if oerr != nil {
			return Outcome{Status: 0, Log: fmt.Sprintf("order %d: price read failed: %v", inst.OrderID, oerr)}
		}
		decision, err = trigger.Evaluate(terms, obs, now())
	}

	if err != nil {
		// Expired orders and stale prices are errors by design: better to
		// refuse than to fire on bad data. The contract will not settle these.
		if errors.Is(err, trigger.ErrExpired) || errors.Is(err, trigger.ErrStalePrice) {
			return Outcome{Status: 0, Log: fmt.Sprintf("order %d: %v", inst.OrderID, err)}
		}
		return Outcome{Status: 0, Log: fmt.Sprintf("order %d: evaluate: %v", inst.OrderID, err)}
	}

	if !decision.Fire {
		// A trailing stop that has not fired still has something to say: the
		// peak may have risen, and the contract is the only place that can
		// remember it. This is emitted as a TRACK result, which settles nothing.
		if terms.Kind == trigger.KindTrailing && newPeak != nil && newPeak.Cmp(inst.PeakE18) > 0 {
			tracking := *terms
			tracking.Action = trigger.ActionTrack
			data, encErr := EncodeResult(inst.OrderID, inst.Contract, &tracking, newPeak, nil)
			if encErr != nil {
				return Outcome{Status: 0, Log: fmt.Sprintf("order %d: encode peak: %v", inst.OrderID, encErr)}
			}
			return Outcome{Status: 1, Data: data, Log: fmt.Sprintf("order %d: peak raised", inst.OrderID)}
		}

		// The no-op path. Deliberately identical in status to a fired result
		// so an observer polling the proxy learns nothing from timing or shape.
		return Outcome{Status: 1, Data: nil, Log: fmt.Sprintf("order %d: no-op", inst.OrderID)}
	}

	data, err := EncodeResult(inst.OrderID, inst.Contract, terms, newPeak, chunk)
	if err != nil {
		return Outcome{Status: 0, Log: fmt.Sprintf("order %d: encode result: %v", inst.OrderID, err)}
	}

	return Outcome{Status: 1, Data: data, Log: fmt.Sprintf("order %d: fired", inst.OrderID)}
}
