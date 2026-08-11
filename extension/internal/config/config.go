// Package config holds the Wraith extension's operation identifiers and tunables.
//
// The OPType and OPCommand strings must match the bytes32 constants in
// contracts/src/WraithOrders.sol exactly. A mismatch is the most common cause of
// "unsupported op type" / "unsupported op command" responses from the TEE node.
package config

const (
	// Version is part of the extension lifecycle: bump it whenever behavior or
	// the on-chain interface changes, because the TEE registration path treats
	// the code version as significant.
	Version = "0.1.0"

	// OPTypeWraith must equal bytes32("WRAITH") in WraithOrders.sol.
	//
	// Names starting with "F_" are reserved for Flare system operations.
	OPTypeWraith = "WRAITH"

	// OPCommandEvalOrder must equal bytes32("EVAL_ORDER") in WraithOrders.sol.
	OPCommandEvalOrder = "EVAL_ORDER"
)
