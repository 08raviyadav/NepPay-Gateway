# NepPay Gateway — Architecture (V0 scaffold)

Independent gateway: merchants integrate once, the gateway routes to Nepal rails
and (later) card acquirers. Cross-platform by design — the gateway is HTTP
APIs + a hosted checkout page; clients are thin SDKs.

```
Merchant website / Android / iOS / Flutter app
        │  SDK (Flutter) or plain HTTPS
        ▼
┌──────────────────────────────────────────────┐
│ NepPay Gateway API (Node, zero-dep in V0)     │
│  /v1/checkout-sessions  /v1/payments         │
│  /v1/payments/:id/refund  /v1/ledger         │
│  /v1/balances  /v1/webhook-events            │
│  Auth: X-API-Key  •  Idempotency-Key required│
│  Core: routing → ledger → webhooks           │
└──────────────┬───────────────────────────────┘
               │ Adapter interface: charge() / refund()
      ┌────────┼──────────┬──────────┬─────────┐
   Mock NPI  Mock FonePay Mock eSewa Mock Khalti Mock Card
   (V1: real NPI / FonePay / connectIPS / card acquirer drop in here)
```

## Core invariants (do not break these in V1)

1. **Idempotency first.** Every `POST /v1/payments` needs an `Idempotency-Key`.
   A retry with the same key returns the original payment — never a second charge.
2. **Double-entry ledger.** Balances are sums of ledger entries, never a mutable
   number. A payment writes: clearing debit → merchant pending credit →
   pending debit → merchant available credit (net) + gateway fees credit.
   A refund reverses available → clearing.
3. **Adapters are swappable.** Routes never call a rail directly; they call
   `adapters.charge(method, payment)`. A real adapter implements the same
   `{ ok, adapterRef }` / `{ ok:false, code, message }` shape.
4. **Webhooks are signed.** Every event carries `sha256=` HMAC of the payload
   with `WEBHOOK_SECRET`. Merchants must verify it before trusting an event.
5. **QR codes are EMVCo, not pictures.** `POST /v1/qr-codes` builds a TLV
   payload (`buildEmvPayload` in `backend/server.js`, CRC16-CCITT in tag 63)
   that any EMVCo reader — including the NepPay app's `EmvQr.tryParse` —
   can parse. The image is just a rendering of that payload
   (`qrImageUrl`, via an external QR-image service in V0; use a local QR
   library in V1). Static = tag 01 `11`, no amount, reusable until
   deactivated. Dynamic = tag 01 `12`, amount in tag 54, single-use, expires
   (default 15 min) and flips to `paid` after one successful payment.
5. **No real money in V0.** Mock adapters simulate success/failure only.
   Amount `1313` always fails; card ending `0002` always declines — so
   merchants can test unhappy paths deterministically.

## V1 upgrade path

- Store: in-memory Maps → Postgres (sessions, payments, ledger, idempotency).
- Auth: demo key → per-merchant API keys + secret keys, scoped, rotatable.
- Webhooks: mock-logged → real POST with retries + exponential back-off.
- Adapters: mock → real NPI (member bank/PSP), FonePay merchant API,
  connectIPS, eSewa/Khalti live APIs, card acquirer + 3D Secure.
- Compliance: NRB PSP licence, PCI DSS (tokenize cards, never store PAN),
  KYC/AML, settlement bank account, daily reconciliation vs bank statements.
- Scale: Redis for idempotency/rate-limit, queue for webhooks, separate
  settlement service. Keep the ledger as the source of truth.
