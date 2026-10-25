# NepPay Gateway — API (V0 sandbox)

Base URL: `http://localhost:8788` — Auth: header `X-API-Key: pk_test_neppay_demo`
Currency: `NPR` only in V0. All amounts are NPR with 2 decimals.

## `GET /health`
`{ "ok": true, "service": "neppay-gateway", "version": "0.1.0-sandbox" }`

## `GET /v1/methods`
Lists payment methods with fee rates: `nepalpay_qr` 1.9%, `fonepay` 1.9%,
`npi` 1.5%, `connectips` 1.5%, `esewa` 2%, `khalti` 2%, `card` 2.5%.

## `POST /v1/checkout-sessions`
Body: `{ "amount": 500, "orderId": "ORDER-1", "customer": { "name": "…" },
"methods": ["nepalpay_qr","fonepay"], "successUrl": "…", "cancelUrl": "…" }`
→ `201 { "id": "cs_…", "checkoutUrl": "http://localhost:8788/checkout/cs_…",
"amount": 500, "currency": "NPR", "status": "open", "expiresAt": "…" }`
Open `checkoutUrl` in any browser / WebView — that is the hosted checkout.

## `POST /v1/payments` — requires `Idempotency-Key` header
Body: `{ "checkoutSessionId": "cs_…", "method": "nepalpay_qr" }`
or `{ "amount": 500, "method": "fonepay", "orderId": "ORDER-1" }`
→ `201 { "id": "pay_…", "status": "succeeded" | "failed", "amount": 500,
"fee": 9.5, "net": 490.5, "adapterRef": "mock_…", "authCode": "…" }`
Same `Idempotency-Key` + same body returns the *same* payment, no second charge.
Test failures: amount `1313` always fails; `card` with `cardLast4: "0002"` declines.

## `GET /v1/payments/:id` and `GET /v1/payments?limit=20`
Retrieve one payment, or list the most recent.

## `POST /v1/payments/:id/refund`
Body: `{ "amount": 100 }` (defaults to full amount). Only `succeeded` payments.
→ `201 { "id": "re_…", "paymentId": "pay_…", "amount": 100, "status": "succeeded" }`

## `GET /v1/balances`
`{ "balances": { "available": 390.5, "pending": 0, "feesCollected": 9.5 } }`
Balances are computed from the ledger, not stored.

## `GET /v1/ledger` — last 50 double-entry entries.

## `GET /v1/webhook-events`
Events emitted so far (`payment.succeeded`, `payment.failed`,
`refund.succeeded`), each with an HMAC `signature` (`sha256=…`).
Verify: `HMAC-SHA256(WEBHOOK_SECRET, raw JSON body)`.

## `GET /v1/merchants/me` — demo merchant profile.

## Errors
`401 unauthorized` (bad/missing API key), `400 invalid_amount | invalid_method |
idempotency_key_required | not_refundable`, `404 not_found`. Shape:
`{ "error": { "code": "…", "message": "…" } }`
