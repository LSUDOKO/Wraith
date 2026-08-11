package enclave

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Decryptor asks the TEE node's built-in /decrypt endpoint (on SIGN_PORT) to
// open an ECIES ciphertext with the enclave key. The private key never leaves
// the node; this package only ever sees plaintext inside the enclave boundary.
type Decryptor struct {
	// BaseURL is the TEE node's local signing endpoint, e.g. "http://127.0.0.1:7701".
	BaseURL string
	// Client defaults to a 10s-timeout client.
	Client *http.Client
}

type decryptRequest struct {
	Ciphertext string `json:"ciphertext"`
}

type decryptResponse struct {
	Plaintext string `json:"plaintext"`
	Error     string `json:"error,omitempty"`
}

// Decrypt opens ciphertext produced against the enclave public key.
func (d *Decryptor) Decrypt(ctx context.Context, ciphertext []byte) ([]byte, error) {
	payload, _ := json.Marshal(decryptRequest{Ciphertext: "0x" + hex.EncodeToString(ciphertext)})

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
		return nil, fmt.Errorf("decrypt decode: %w", err)
	}
	if out.Error != "" {
		return nil, fmt.Errorf("decrypt: %s", out.Error)
	}

	plaintext, err := hex.DecodeString(strings.TrimPrefix(out.Plaintext, "0x"))
	if err != nil {
		return nil, fmt.Errorf("decrypt: bad plaintext hex: %w", err)
	}
	return plaintext, nil
}
