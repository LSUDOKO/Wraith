package enclave

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Decryptor asks the TEE node's built-in `POST /decrypt` endpoint to open an
// ECIES ciphertext with the enclave key. The private key never leaves the node;
// this package only ever sees plaintext inside the enclave boundary.
//
// The request and response shapes mirror tee-node's DecryptRequest and
// DecryptResponse exactly. Both fields are Go []byte, which encoding/json
// marshals as base64 — not hex. Getting that wrong yields a 400 from a server
// that is otherwise reachable, which is a confusing failure to debug, so the
// encoding is asserted by the round-trip test rather than assumed.
type Decryptor struct {
	// BaseURL is the TEE node's local extension endpoint, e.g. "http://127.0.0.1:9090".
	BaseURL string
	// Client defaults to a 10s-timeout client.
	Client *http.Client
}

// decryptRequest matches tee-node/pkg/types.DecryptRequest.
type decryptRequest struct {
	EncryptedMessage []byte `json:"encryptedMessage"`
}

// decryptResponse matches tee-node/pkg/types.DecryptResponse.
type decryptResponse struct {
	DecryptedMessage []byte `json:"decryptedMessage"`
}

// Decrypt opens ciphertext produced against the enclave public key.
func (d *Decryptor) Decrypt(ctx context.Context, ciphertext []byte) ([]byte, error) {
	payload, err := json.Marshal(decryptRequest{EncryptedMessage: ciphertext})
	if err != nil {
		return nil, fmt.Errorf("decrypt: encoding request: %w", err)
	}

	client := d.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, strings.TrimRight(d.BaseURL, "/")+"/decrypt", bytes.NewReader(payload),
	)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("decrypt: node returned %d", resp.StatusCode)
	}

	var out decryptResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decrypt: decoding response: %w", err)
	}
	if len(out.DecryptedMessage) == 0 {
		return nil, fmt.Errorf("decrypt: node returned an empty plaintext")
	}
	return out.DecryptedMessage, nil
}
