# Security

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Forbidden
- Committing `.env` files, secret dumps, or private keys.
- Hardcoding secrets, tokens, credentials, webhook secrets, or signing keys.
- Logging secrets, tokens, card data, or full PII payloads.
- Disabling auth/authorization checks as a temporary workaround.
- Trusting webhook payloads without signature and replay checks.

## Mandatory Baseline
- Validate all incoming data at boundary layers (DTO/request schema + business validation).
- Use parameterized queries and safe ORM patterns (no string-built SQL).
- Enforce authorization checks at service-level operations, not only at controller level.
- Apply least-privilege defaults for service accounts and integration credentials.

## OWASP-Oriented Controls
- Injection: no dynamic query concatenation; sanitize and validate untrusted inputs.
- XSS: encode output in UI surfaces; avoid unsafe HTML rendering.
- CSRF: enforce anti-CSRF protections where cookie/session auth is used.
- SSRF: block internal-network target access for user-controlled URLs.
- Broken Access Control: deny by default and verify ownership/tenant boundaries.

## JWT and Authentication
- Validate issuer, audience, expiry, signature, and algorithm constraints.
- Reject expired/invalid tokens and enforce clock-skew tolerance policy.
- Do not trust client claims without server-side authorization checks.
- Support key rotation and avoid static long-lived signing material.

## Webhook and Payment Controls
- Require HMAC/signature validation before processing.
- Enforce replay protection and idempotency for webhook events.
- Persist external event IDs and reject duplicates safely.
- Treat payment state transitions as auditable and monotonic.

## Network and Platform Controls
- Restrictive CORS policy (allowlist origins/methods/headers only).
- Rate limiting/throttling on gateway and abuse-prone endpoints.
- Security headers for web apps (CSP, X-Content-Type-Options, frame protections).
- Secrets from secure stores (Vault/KMS/secret manager), not from repo files.

## Audit and Observability
- Emit security-relevant audit logs (auth failures, privilege changes, payment/webhook rejects).
- Avoid sensitive payload logging; log correlation ids and security decision outcomes.
- Document incident-impacting security changes in changelog/release notes.
