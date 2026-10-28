# Response Encryption

The `openclaw` security profile includes end-to-end encryption of secret responses using ECDH key exchange and AES-256-GCM.

## Overview

When `secretsEncrypted: true` is enabled in a security profile, the server encrypts all `/secret/:name` endpoint responses. This ensures secrets are never transmitted in plaintext, even over TLS.

## How It Works

### Encryption Flow

```
Client                                Server
  |                                     |
  |  1. Generate ECDH P-256 keypair    |
  |                                     |
  |  2. Send public key in header      |
  | ----------------------------------> |
  |     X-Client-Public-Key: base64    |
  |                                     |
  |                                     |  3. Generate ephemeral keypair
  |                                     |  4. Derive shared secret (ECDH)
  |                                     |  5. Encrypt response (AES-256-GCM)
  |                                     |
  | <---------------------------------- |
  |  6. Receive encrypted response     |
  |     X-Server-Public-Key: base64    |
  |     X-Encryption-Nonce: base64     |
  |     Body: base64 ciphertext        |
  |                                     |
  |  7. Derive shared secret (ECDH)    |
  |  8. Decrypt response               |
  |  9. Parse JSON                     |
```

### Cryptographic Primitives

- **Key Exchange:** ECDH with P-256 elliptic curve
- **Encryption:** AES-256-GCM
- **Nonce:** 12 bytes (randomly generated per response)
- **Authentication Tag:** 16 bytes (included in GCM ciphertext)

### Security Properties

- **Forward Secrecy:** Server generates new ephemeral keypair for each request
- **Authenticated Encryption:** AES-GCM provides confidentiality + integrity
- **No Key Reuse:** Each response uses unique nonce and ephemeral keys
- **End-to-End:** Secrets encrypted before leaving server, decrypted only by client

## Client Implementation

### 1. Generate Keypair

```typescript
import {
  generateKeyPair,
  exportPublicKey,
  base64Encode,
} from './server/utils/crypto';

const clientKeyPair = await generateKeyPair();
const clientPublicKeyBytes = await exportPublicKey(clientKeyPair.publicKey);
const clientPublicKeyBase64 = base64Encode(clientPublicKeyBytes);
```

### 2. Make Request

```typescript
const response = await fetch('http://localhost:3000/secret/my-password', {
  headers: {
    'Authorization': 'Bearer YOUR_API_TOKEN',
    'X-Client-Public-Key': clientPublicKeyBase64,
  },
});
```

### 3. Extract Encryption Metadata

```typescript
const serverPublicKeyBase64 = response.headers.get('X-Server-Public-Key');
const nonceBase64 = response.headers.get('X-Encryption-Nonce');
const ciphertextBase64 = await response.text();
```

### 4. Decrypt Response

```typescript
import {
  deriveSharedSecret,
  decryptResponse,
  importPublicKey,
  base64Decode,
} from './server/utils/crypto';

// Import server public key
const serverPublicKeyBytes = base64Decode(serverPublicKeyBase64);
const serverPublicKey = await importPublicKey(serverPublicKeyBytes);

// Derive shared secret
const sharedSecret = await deriveSharedSecret(
  clientKeyPair.privateKey,
  serverPublicKey
);

// Decrypt
const nonce = base64Decode(nonceBase64);
const ciphertext = base64Decode(ciphertextBase64);
const decrypted = await decryptResponse(ciphertext, nonce, sharedSecret);

// Parse JSON
const secret = JSON.parse(decrypted);
console.log(secret.value); // "my-secret-password"
```

## Example Client

See `examples/encrypted-client.ts` for a complete working example.

### Usage

```bash
# Set environment variables
export SERVER_URL="http://localhost:3000"
export API_TOKEN="your-token-here"

# Run example client
bun examples/encrypted-client.ts "my-secret-name"
```

### Output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Encrypted Secret Retrieval Example
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Secret:      my-secret-name
Server URL:  http://localhost:3000
API Token:   ✓ configured
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Generating client keypair...
Requesting secret from server...
Decrypting response...

✓ Successfully retrieved and decrypted secret:

{
  "value": "my-secret-password"
}
```

## Error Handling

### Missing Client Public Key

**Request:**
```
GET /secret/test
(no X-Client-Public-Key header)
```

**Response:**
```json
{
  "error": "Encryption required",
  "message": "X-Client-Public-Key header is required for this profile"
}
```
Status: `400 Bad Request`

### Invalid Client Public Key

**Request:**
```
GET /secret/test
X-Client-Public-Key: invalid-base64!!!
```

**Response:**
```json
{
  "error": "Invalid client public key",
  "message": "Invalid key format"
}
```
Status: `400 Bad Request`

### Secret Not Found

**Request:**
```
GET /secret/nonexistent
X-Client-Public-Key: (valid key)
```

**Response:** (NOT encrypted)
```json
{
  "error": "Secret not found"
}
```
Status: `404 Not Found`

Note: Error responses are NOT encrypted - only successful `200 OK` responses with secrets are encrypted.

## Security Profile Configuration

### Enable Encryption

```typescript
// server/profiles.ts
export const SecurityProfiles = {
  openclaw: {
    name: 'OpenClaw / Clawdbot',
    secretsEncrypted: true, // Enable response encryption
    // ... other settings
  },
}
```

### Start Server with Encryption

```bash
export SECURITY_PROFILE=openclaw
export ALLOWED_CERT_FINGERPRINTS="sha256:your-fingerprint"
export JWT_SECRET="$(openssl rand -hex 32)"
bun run server
```

You'll see:
```
Active security layers:
  ✓ IP Whitelist: 127.0.0.1/32
  ✓ Rate Limiting: 30/1m
  ✓ mTLS: 1 fingerprint(s), mode=proxy
  ✓ JWT: Required scopes=read:secrets
  ✓ Combined Auth: mTLS + JWT (defense in depth)
  ✓ Audit Logging: forensic
  ✓ Response Encryption: ECDH P-256 + AES-256-GCM
```

## API Reference

### Crypto Utilities

See `server/utils/crypto.ts` for detailed API documentation.

**Key Functions:**
- `generateKeyPair()` - Generate ECDH P-256 keypair
- `deriveSharedSecret(privateKey, publicKey)` - Derive AES-256 key via ECDH
- `encryptResponse(data, sharedSecret)` - Encrypt with AES-256-GCM
- `decryptResponse(ciphertext, nonce, sharedSecret)` - Decrypt response
- `exportPublicKey(publicKey)` - Export key to bytes
- `importPublicKey(keyBytes)` - Import key from bytes
- `base64Encode(bytes)` - Encode bytes to base64 string
- `base64Decode(encoded)` - Decode base64 string to bytes

### Headers

**Request Headers:**
- `X-Client-Public-Key` - Base64-encoded ECDH P-256 public key (65 bytes uncompressed)

**Response Headers:**
- `X-Server-Public-Key` - Base64-encoded ephemeral server public key
- `X-Encryption-Nonce` - Base64-encoded 12-byte nonce
- `Content-Type` - `application/octet-stream` (encrypted responses only)

**Response Body:**
- Base64-encoded ciphertext (includes 16-byte GCM auth tag)

## Testing

### Run Tests

```bash
# Crypto utilities
bun test server/__tests__/crypto.test.ts

# Middleware
bun test server/__tests__/response-encryption.test.ts

# All tests
bun test server/__tests__/
```

### Test Coverage

- Key generation uniqueness
- ECDH key exchange correctness
- Encrypt/decrypt round-trip
- Invalid key rejection
- Tampered ciphertext detection
- Middleware integration
- Full client-server flow

## Performance Considerations

### Overhead per Request

- **Key Generation:** ~1ms (ephemeral server keypair)
- **Key Exchange:** ~0.5ms (ECDH)
- **Encryption:** ~0.1ms (AES-GCM, depends on secret size)
- **Total:** ~1.5-2ms additional latency

### Optimization Tips

1. **Reuse Client Keypair:** Generate once, reuse across requests (within session)
2. **Parallel Requests:** Server generates unique ephemeral keys per request
3. **Secret Size:** Encryption time grows linearly with secret size (negligible for typical passwords/tokens)

## Why Not TLS Alone?

TLS provides transport-layer encryption, but:

1. **Defense in Depth:** Even if TLS is compromised (weak ciphers, MITM), secrets remain encrypted
2. **End-to-End:** Secrets encrypted before leaving server process, decrypted only by client
3. **Auditability:** Encrypted responses logged/stored are useless without client private key
4. **Zero Trust:** Don't trust the network, even internal networks

The `openclaw` profile uses `tls: 'required+strict'` + response encryption for maximum paranoia.

## Troubleshooting

### "The algorithm is not supported"

If you see this error, ensure you're using a runtime with full Web Crypto API support:
- **Bun:** ✓ Supported (ECDH P-256)
- **Node.js:** ✓ Supported (v15+)
- **Deno:** ✓ Supported

### "Invalid state: ReadableStream is locked"

This indicates the response body was read multiple times. The middleware clones the response before reading to avoid this issue. If you see this error, ensure you're not reading `res.text()` or `res.json()` before the middleware runs.

### Decryption Fails

**Possible causes:**
- Wrong client private key used
- Server public key not imported correctly
- Nonce mismatch
- Ciphertext corrupted/tampered

**Debug:**
1. Verify base64 decoding is correct
2. Check public key lengths (65 bytes for P-256 uncompressed)
3. Ensure nonce is 12 bytes
4. Confirm ciphertext includes 16-byte auth tag
