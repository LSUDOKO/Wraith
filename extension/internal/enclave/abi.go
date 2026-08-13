// Package enclave is the runtime glue between the pure trigger core and the
// world: ABI codecs for the fixed Wraith layouts, the FTSO price reader, the
// TEE-node decrypt client, and the action handler that ties them together.
//
// The ABI code is hand-rolled for exactly the three layouts Wraith uses rather
// than pulling in go-ethereum: the layouts are fixed by the contract, and a
// dependency-light enclave image is easier to reproduce and audit.
package enclave

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/LSUDOKO/Wraith/extension/internal/trigger"
)

const word = 32

var (
	ErrShortData   = errors.New("abi: data too short")
	ErrBadOffset   = errors.New("abi: dynamic offset out of range")
	ErrBadAddress  = errors.New("abi: malformed address word")
	ErrValueRange  = errors.New("abi: value out of range for target type")
	ErrTrailingGap = errors.New("abi: string length exceeds data")
)

// slot returns the i-th 32-byte word.
func slot(data []byte, i int) ([]byte, error) {
	start := i * word
	if len(data) < start+word {
		return nil, fmt.Errorf("%w: want slot %d, have %d bytes", ErrShortData, i, len(data))
	}
	return data[start : start+word], nil
}

func slotBig(data []byte, i int) (*big.Int, error) {
	s, err := slot(data, i)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetBytes(s), nil
}

func slotUint64(data []byte, i int) (uint64, error) {
	v, err := slotBig(data, i)
	if err != nil {
		return 0, err
	}
	if !v.IsUint64() {
		return 0, ErrValueRange
	}
	return v.Uint64(), nil
}

func slotAddress(data []byte, i int) (string, error) {
	s, err := slot(data, i)
	if err != nil {
		return "", err
	}
	for _, b := range s[:12] {
		if b != 0 {
			return "", ErrBadAddress
		}
	}
	return "0x" + hex.EncodeToString(s[12:]), nil
}

// slotString reads a dynamic string whose offset lives in head slot i.
func slotString(data []byte, i int) (string, error) {
	offset, err := slotUint64(data, i)
	if err != nil {
		return "", err
	}
	if offset+word > uint64(len(data)) {
		return "", ErrBadOffset
	}
	length := new(big.Int).SetBytes(data[offset : offset+word])
	if !length.IsUint64() || offset+word+length.Uint64() > uint64(len(data)) {
		return "", ErrTrailingGap
	}
	return string(data[offset+word : offset+word+length.Uint64()]), nil
}

func padLeft(b []byte) []byte {
	out := make([]byte, word)
	copy(out[word-len(b):], b)
	return out
}

func encodeUint(v *big.Int) []byte { return padLeft(v.Bytes()) }

func encodeAddress(addr string) ([]byte, error) {
	h := strings.TrimPrefix(strings.ToLower(addr), "0x")
	if len(h) != 40 {
		return nil, fmt.Errorf("%w: %q", ErrBadAddress, addr)
	}
	raw, err := hex.DecodeString(h)
	if err != nil {
		return nil, fmt.Errorf("%w: %q", ErrBadAddress, addr)
	}
	return padLeft(raw), nil
}

// Instruction is the ABI payload tick() sends:
// abi.encode(uint256 orderId, address contractAddr, bytes encrypted,
// uint256 peakE18, uint256 remaining).
type Instruction struct {
	OrderID    uint64
	Contract   string
	Ciphertext []byte
	// PeakE18 is the running high-water mark for trailing stops, read from
	// on-chain because the enclave keeps nothing between ticks.
	PeakE18 *big.Int
	// RemainingE18 is escrow the order has not spent yet. A chunked order
	// infers its progress from this rather than from anything remembered.
	RemainingE18 *big.Int
}

// DecodeInstruction parses the message from WraithOrders.tick().
func DecodeInstruction(data []byte) (*Instruction, error) {
	orderID, err := slotUint64(data, 0)
	if err != nil {
		return nil, err
	}
	contract, err := slotAddress(data, 1)
	if err != nil {
		return nil, err
	}

	offset, err := slotUint64(data, 2)
	if err != nil {
		return nil, err
	}
	if offset+word > uint64(len(data)) {
		return nil, ErrBadOffset
	}
	length := new(big.Int).SetBytes(data[offset : offset+word])
	if !length.IsUint64() || offset+word+length.Uint64() > uint64(len(data)) {
		return nil, ErrTrailingGap
	}

	peak, err := slotBig(data, 3)
	if err != nil {
		// Older senders omit these; treat them as zero rather than failing, so
		// an order from a previous deployment still evaluates.
		peak = new(big.Int)
	}
	remaining, err := slotBig(data, 4)
	if err != nil {
		remaining = new(big.Int)
	}

	return &Instruction{
		OrderID:    orderID,
		Contract:   contract,
		Ciphertext: data[offset+word : offset+word+length.Uint64()],
		PeakE18:      peak,
		RemainingE18: remaining,
	}, nil
}

// DecodeTerms parses the plaintext the frontend sealed:
// abi.encode(address contract, bytes21 feedId, string direction,
// uint256 thresholdE18, uint8 action, uint256 minOutOrLots,
// address tokenOut, string underlyingAddress, uint64 expiry,
// uint256 secondThresholdE18).
//
// secondThresholdE18 is appended last so it stays wire-compatible in review:
// zero means a plain single-leg order, non-zero makes it a bracket.
//
// This is the only function that ever sees an order's plaintext.
func DecodeTerms(data []byte) (*trigger.Terms, error) {
	contract, err := slotAddress(data, 0)
	if err != nil {
		return nil, fmt.Errorf("contract: %w", err)
	}

	feedSlot, err := slot(data, 1)
	if err != nil {
		return nil, err
	}
	// bytes21 is left-aligned in its word.
	feedID := "0x" + hex.EncodeToString(feedSlot[:21])

	direction, err := slotString(data, 2)
	if err != nil {
		return nil, fmt.Errorf("direction: %w", err)
	}
	threshold, err := slotBig(data, 3)
	if err != nil {
		return nil, err
	}
	action, err := slotUint64(data, 4)
	if err != nil {
		return nil, err
	}
	if action > 255 {
		return nil, ErrValueRange
	}
	minOutOrLots, err := slotBig(data, 5)
	if err != nil {
		return nil, err
	}
	tokenOut, err := slotAddress(data, 6)
	if err != nil {
		return nil, fmt.Errorf("tokenOut: %w", err)
	}
	underlying, err := slotString(data, 7)
	if err != nil {
		return nil, fmt.Errorf("underlyingAddress: %w", err)
	}
	expiry, err := slotUint64(data, 8)
	if err != nil {
		return nil, err
	}
	secondThreshold, err := slotBig(data, 9)
	if err != nil {
		return nil, err
	}
	kind, err := slotUint64(data, 10)
	if err != nil {
		return nil, err
	}
	agent, err := slotAddress(data, 11)
	if err != nil {
		return nil, fmt.Errorf("agent: %w", err)
	}
	minCollateral, err := slotUint64(data, 12)
	if err != nil {
		return nil, err
	}
	trail, err := slotUint64(data, 13)
	if err != nil {
		return nil, err
	}
	seedWord, err := slot(data, 14)
	if err != nil {
		return nil, err
	}
	var seed [32]byte
	copy(seed[:], seedWord)
	chunks, err := slotUint64(data, 15)
	if err != nil {
		return nil, err
	}
	startAt, err := slotUint64(data, 16)
	if err != nil {
		return nil, err
	}
	endAt, err := slotUint64(data, 17)
	if err != nil {
		return nil, err
	}
	// Zero is the sentinel for "no second leg"; Terms uses nil.
	if secondThreshold.Sign() == 0 {
		secondThreshold = nil
	}

	return &trigger.Terms{
		Contract:          contract,
		FeedID:            feedID,
		Direction:         trigger.Direction(direction),
		ThresholdE18:      threshold,
		Action:            trigger.Action(action),
		MinOutOrLots:      minOutOrLots,
		TokenOut:          tokenOut,
		UnderlyingAddress:  underlying,
		Expiry:             expiry,
		SecondThresholdE18: secondThreshold,
		Kind:               trigger.Kind(kind),
		Agent:              agent,
		MinCollateralBIPS:  minCollateral,
		TrailBIPS:          trail,
		Seed:               seed,
		Chunks:             chunks,
		StartAt:            startAt,
		EndAt:              endAt,
	}, nil
}

// EncodeResult builds the ActionResult.Data that WraithOrders.execute() decodes:
// abi.encode(uint256 orderId, address contractAddr, uint8 action,
// uint256 minOutOrLots, address tokenOut, string underlyingAddress,
// uint256 newPeakE18, uint256 chunkAmount).
//
// It carries no trace of the threshold, trail distance or direction — only what
// settlement needs, plus a peak the contract already treats as public.
func EncodeResult(
	orderID uint64, contract string, t *trigger.Terms, newPeakE18, chunkE18 *big.Int,
) ([]byte, error) {
	contractWord, err := encodeAddress(contract)
	if err != nil {
		return nil, err
	}
	tokenOut := t.TokenOut
	if strings.TrimSpace(tokenOut) == "" {
		tokenOut = "0x0000000000000000000000000000000000000000"
	}
	tokenOutWord, err := encodeAddress(tokenOut)
	if err != nil {
		return nil, err
	}

	underlying := []byte(t.UnderlyingAddress)
	padded := make([]byte, (len(underlying)+word-1)/word*word)
	copy(padded, underlying)

	var out []byte
	out = append(out, encodeUint(new(big.Int).SetUint64(orderID))...)
	out = append(out, contractWord...)
	out = append(out, encodeUint(new(big.Int).SetUint64(uint64(t.Action)))...)
	out = append(out, encodeUint(t.MinOutOrLots)...)
	out = append(out, tokenOutWord...)
	out = append(out, encodeUint(big.NewInt(8*word))...) // offset of the string tail
	peak := newPeakE18
	if peak == nil {
		peak = new(big.Int)
	}
	out = append(out, encodeUint(peak)...)
	chunk := chunkE18
	if chunk == nil {
		chunk = new(big.Int)
	}
	out = append(out, encodeUint(chunk)...)
	out = append(out, encodeUint(big.NewInt(int64(len(underlying))))...)
	out = append(out, padded...)
	return out, nil
}
