# NepPay Gateway

**An independent, cross-platform payment gateway scaffold for Nepal — sandbox only, no real money.**

Merchants integrate once (Flutter SDK, hosted checkout, or plain HTTPS) and the
gateway routes to NEPALPAY QR, FonePay, NPI, connectIPS, eSewa, Khalti and cards
via swappable adapters. This V0 ships with **mock adapters**; real rails drop
in behind the same interface in V1.

> ⚠️ **Not a licensed payment service.** Live payments need a partner bank/PSP
> and an NRB PSP licence. See `docs/ARCHITECTURE.md` for the V1 path, and
> `docs/API.md` for the full API.

## What is inside

```
neppay-gateway/
├── backend/            # Node, zero dependencies — gateway API + ledger + webhooks
│   ├── server.js       # checkout sessions, payments, refunds, ledger, mock adapters
│   └── test.js         # smoke tests (npm test)
├── sdk/flutter/        # Cross-platform SDK: Android, iOS, Web, Desktop
│   ├── lib/neppay_gateway.dart   # client + NepPayCheckoutSheet widget
│   └── example/main.dart         # demo merchant app
├── demo-merchant/      # Plain-HTML store that opens the hosted checkout
├── docs/               # ARCHITECTURE.md, API.md
└── .env.example
```

## Quick start

```bash
cd backend
node server.js          # http://localhost:8788  (Node 18+, no npm install needed)
# in another terminal:
npm test                # 9 smoke tests: session → pay → idempotent retry → refund
```

Try it with curl (demo key: `pk_test_neppay_demo`):

```bash
curl localhost:8788/v1/methods
curl -X POST localhost:8788/v1/checkout-sessions \
  -H 'X-API-Key: pk_test_neppay_demo' -H 'Content-Type: application/json' \
  -d '{"amount":500,"orderId":"ORDER-1"}'
# open the returned checkoutUrl in a browser and pay with any method
curl -X POST localhost:8788/v1/payments \
  -H 'X-API-Key: pk_test_neppay_demo' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-001' \
  -d '{"amount":500,"method":"nepalpay_qr"}'
curl localhost:8788/v1/balances -H 'X-API-Key: pk_test_neppay_demo'
```

## QR payments — static + dynamic

```bash
# Static QR: one fixed merchant QR, customer enters the amount (reusable)
curl -X POST localhost:8788/v1/qr-codes \
  -H 'X-API-Key: pk_test_neppay_demo' -H 'Content-Type: application/json' \
  -d '{"type":"static","scheme":"nepalpay_qr"}'
# Dynamic QR: amount embedded, single-use, expires in 15 min by default
curl -X POST localhost:8788/v1/qr-codes \
  -H 'X-API-Key: pk_test_neppay_demo' -H 'Content-Type: application/json' \
  -d '{"type":"dynamic","scheme":"fonepay","amount":250,"orderId":"ORDER-QR-1"}'
# Open the returned displayUrl (/qr/qr_…) to see the QR and pay from the page,
# or pay it directly (amount comes from the QR for dynamic, enter it for static):
curl -X POST localhost:8788/v1/payments \
  -H 'X-API-Key: pk_test_neppay_demo' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: qr-demo-001' \
  -d '{"qrCodeId":"qr_…","amount":100}'
```

Each QR returns a real EMVCo TLV payload (tag 01 = `11` static / `12` dynamic,
CRC16 in tag 63) — the same format the NepPay app parses. Flutter SDK:
`createQrCode()`, `getQrCode()`, `listQrCodes()`, `payWithQr()`.

## Pay by username / phone number

```bash
# Register a payee (username + phone are both unique)
curl -X POST localhost:8788/v1/users \
  -H 'X-API-Key: pk_test_neppay_demo' -H 'Content-Type: application/json' \
  -d '{"username":"maya.sharma","phone":"9841000002","displayName":"Maya Sharma"}'
# Name inquiry first — see who you are paying before you send
curl 'localhost:8788/v1/users/lookup?username=@maya.sharma' -H 'X-API-Key: pk_test_neppay_demo'
# Pay them (free p2p transfer, no method needed)
curl -X POST localhost:8788/v1/payments \
  -H 'X-API-Key: pk_test_neppay_demo' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: p2p-demo-001' \
  -d '{"to":"@maya.sharma","amount":200}'
# Or share the pay link: http://localhost:8788/pay/maya.sharma
```

Demo payees: `@himalayan`, `@maya.sharma`, `@sagar`. Flutter SDK:
`registerUser()`, `lookupUser()`, `payTo()`.

## Test cards / failure cases

- Amount `1313` always fails (mock `insufficient_funds`) — test your error UI.
- Card with `cardLast4: "0002"` always declines.
- Re-send any payment with the same `Idempotency-Key` — you get the original
  payment back, never a second charge.
- A dynamic QR pays once, then a second pay is rejected; a static QR stays
  active until you deactivate it.

## Cross-platform

- **Flutter SDK** (`sdk/flutter`): one codebase, Android / iOS / Web / Desktop.
  `NepPayGatewayClient` for API calls, `NepPayCheckoutSheet` as a drop-in UI.
- **Hosted checkout** (`/checkout/:id`): any website or WebView can open it —
  no SDK needed at all.
- **Plain HTTPS**: any platform can call the REST API directly; see `docs/API.md`.

## Fees (V0, mock)

NPI / connectIPS 1.5% · NEPALPAY QR / FonePay 1.9% · eSewa / Khalti 2% · Card 2.5%.

## Next steps (V1)

Postgres instead of in-memory store → real adapters (NPI/FonePay via a partner
bank) → real webhook delivery with retries → per-merchant keys → NRB PSP licence.
Details in `docs/ARCHITECTURE.md`.

## License

MIT — see NepPay (`~/workspace/payment-app/`), the sibling payment *app* this
gateway is designed to serve.
