// NepPay Gateway — independent payment gateway scaffold (V0, sandbox only)
// Zero dependencies, Node 18+. No real money moves. Mock adapters only.
// Run: node server.js  -> http://localhost:8788
// Docs: ../docs/API.md  ../docs/ARCHITECTURE.md
'use strict';
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8788;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'whsec_test_demo_neppay_gateway';
const DEMO_KEYS = new Set(['pk_test_neppay_demo', 'sk_test_neppay_demo']);

// ---- In-memory store (swap for Postgres in V1; see docs/ARCHITECTURE.md) ----
const db = {
  merchants: [{ id: 'acct_demo', name: 'Demo Merchant — Himalayan Store', email: 'demo@neppay.example', balanceAccount: 'merchant:acct_demo:available' }],
  sessions: new Map(),   // cs_* -> session
  payments: new Map(),   // pay_* -> payment
  refunds: new Map(),    // re_* -> refund
  ledger: [],            // double-entry entries
  idempotency: new Map(),// key -> { status, body, paymentId }
  webhooks: [],          // delivered (mock) webhook events
  qrCodes: new Map(),    // qr_* -> QR code (static or dynamic)
};

const FEE_RATE = { nepalpay_qr: 0.019, fonepay: 0.019, npi: 0.015, connectips: 0.015, esewa: 0.02, khalti: 0.02, card: 0.025 };
const METHODS = [
  { id: 'nepalpay_qr', name: 'NEPALPAY QR', type: 'qr', currency: 'NPR', feeRate: FEE_RATE.nepalpay_qr },
  { id: 'fonepay', name: 'FonePay QR', type: 'qr', currency: 'NPR', feeRate: FEE_RATE.fonepay },
  { id: 'npi', name: 'NPI Bank Transfer', type: 'bank', currency: 'NPR', feeRate: FEE_RATE.npi },
  { id: 'connectips', name: 'connectIPS', type: 'bank', currency: 'NPR', feeRate: FEE_RATE.connectips },
  { id: 'esewa', name: 'eSewa', type: 'wallet', currency: 'NPR', feeRate: FEE_RATE.esewa },
  { id: 'khalti', name: 'Khalti', type: 'wallet', currency: 'NPR', feeRate: FEE_RATE.khalti },
  { id: 'card', name: 'Visa / Mastercard', type: 'card', currency: 'NPR', feeRate: FEE_RATE.card },
];

const nid = (p) => p + '_' + crypto.randomBytes(9).toString('hex');
const now = () => new Date().toISOString();
const paisa = (n) => Math.round(n * 100) / 100; // NPR, 2dp

// ---- EMVCo QR payloads (merchant-presented, same format the NepPay app parses) ----
// TLV: tag(2) + length(2) + value. Tag 63 is CRC16-CCITT (poly 0x1021, init 0xFFFF).
// 00=format, 01=initiation (11 static / 12 dynamic), 26/27=merchant account info,
// 52=MCC, 53=currency (524=NPR), 54=amount (dynamic only), 58=country, 59=name,
// 60=city, 62=additional data (01=order/bill, 05=QR reference), 63=CRC.
// NOTE: GUI / merchant-account values here are sandbox placeholders. A live
// NEPALPAY/FonePay QR must use the GUI and merchant ID issued by NCHL / the
// merchant's bank — the builder shape stays the same, only those values change.
function tlv(tag, value) {
  const v = String(value);
  return tag + String(v.length).padStart(2, '0') + v;
}
function crc16ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function buildEmvPayload({ scheme, type, merchantName, merchantCity, merchantAccountId, amount, orderId, qrId }) {
  const gui = scheme === 'fonepay' ? 'np.fonepay' : 'np.nchl.nepalpay';
  const maiTag = scheme === 'fonepay' ? '27' : '26';
  const mai = tlv('00', gui) + tlv('01', merchantAccountId) + tlv('02', qrId);
  let p = tlv('00', '01') + tlv('01', type === 'dynamic' ? '12' : '11') + tlv(maiTag, mai)
    + tlv('52', '5399') + tlv('53', '524');
  if (type === 'dynamic') p += tlv('54', Number(amount).toFixed(2));
  p += tlv('58', 'NP') + tlv('59', String(merchantName).slice(0, 25)) + tlv('60', String(merchantCity).slice(0, 15));
  p += tlv('62', tlv('01', String(orderId || qrId).slice(0, 25)) + tlv('05', qrId));
  const withCrcTag = p + '6304';
  return withCrcTag + crc16ccitt(withCrcTag);
}
function qrImageUrl(payload) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=' + encodeURIComponent(payload);
}
function qrStatus(qr) {
  if (qr.status === 'active' && qr.expiresAt && Date.now() > Date.parse(qr.expiresAt)) qr.status = 'expired';
  return qr.status;
}

function ledgerEntry({ txnId, account, debit = 0, credit = 0, memo }) {
  const e = { id: nid('le'), txnId, account, debit: paisa(debit), credit: paisa(credit), currency: 'NPR', memo, createdAt: now() };
  db.ledger.push(e); return e;
}
function balance(account) {
  return paisa(db.ledger.filter((e) => e.account === account).reduce((s, e) => s + e.credit - e.debit, 0));
}
function signWebhook(payload) {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
}
function emitWebhook(type, data) {
  const event = { id: nid('evt'), type, data, createdAt: now() };
  const payload = JSON.stringify(event);
  event.signature = signWebhook(payload);
  event.delivery = 'mock-logged'; // V1: POST to merchant.webhookUrl with this signature
  db.webhooks.push(event);
  console.log(`[webhook] ${type} ${event.id} sig=${event.signature.slice(0, 20)}…`);
  return event;
}

// ---- Mock adapters: same interface a real NPI/FonePay adapter must implement ----
// Real adapters drop in here in V1 — same { charge(), refund() } shape, no route changes.
const adapters = {
  async charge(method, payment) {
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 350));
    // Deterministic test failures so merchants can test unhappy paths:
    // amount 1313 always fails; card ending 0002 always declines.
    if (payment.amount === 1313) return { ok: false, code: 'insufficient_funds', message: 'Mock adapter: test failure for amount 1313' };
    if (method === 'card' && String(payment.cardLast4 || '') === '0002') return { ok: false, code: 'card_declined', message: 'Mock adapter: test card declined' };
    return { ok: true, adapterRef: `mock_${method}_${crypto.randomBytes(5).toString('hex')}`, authCode: String(Math.floor(100000 + Math.random() * 900000)) };
  },
  async refund(method, payment, amount) {
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, adapterRef: `mock_refund_${crypto.randomBytes(5).toString('hex')}` };
  },
};

// ---- HTTP helpers ----
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({ __badJson: true }); } });
  });
}
function authed(req) { return DEMO_KEYS.has(req.headers['x-api-key'] || ''); }

// ---- Routes ----
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (path === '/health') return send(res, 200, { ok: true, service: 'neppay-gateway', version: '0.2.0-sandbox', time: now() });
  if (path === '/v1/methods') return send(res, 200, { methods: METHODS });

  // Hosted checkout page (cross-platform: any browser / WebView can open it)
  if (path.startsWith('/checkout/')) {
    const id = path.split('/')[2];
    const s = db.sessions.get(id);
    if (!s) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>Checkout session not found</h1>'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(checkoutHtml(s));
  }

  // QR display page — scan this with any EMVCo QR app (or use the Pay button below)
  if (path.startsWith('/qr/')) {
    const id = path.split('/')[2];
    const qr = db.qrCodes.get(id);
    if (!qr) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>QR code not found</h1>'); }
    qrStatus(qr);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(qrHtml(qr));
  }

  // All /v1/* below need an API key (demo key in README / .env.example)
  if (path.startsWith('/v1/') && !authed(req)) return send(res, 401, { error: { code: 'unauthorized', message: 'Missing or invalid X-API-Key. Use pk_test_neppay_demo for sandbox.' } });

  const body = req.method === 'POST' ? await readBody(req) : {};
  if (body.__badJson) return send(res, 400, { error: { code: 'bad_json', message: 'Request body is not valid JSON' } });

  // POST /v1/checkout-sessions
  if (req.method === 'POST' && path === '/v1/checkout-sessions') {
    if (!body.amount || body.amount <= 0) return send(res, 400, { error: { code: 'invalid_amount', message: 'amount (NPR, > 0) is required' } });
    if (body.currency && body.currency !== 'NPR') return send(res, 400, { error: { code: 'unsupported_currency', message: 'V0 supports NPR only' } });
    const s = { id: nid('cs'), object: 'checkout_session', merchantId: 'acct_demo', amount: paisa(body.amount), currency: 'NPR', orderId: body.orderId || null, customer: body.customer || {}, methods: body.methods || METHODS.map((m) => m.id), successUrl: body.successUrl || null, cancelUrl: body.cancelUrl || null, metadata: body.metadata || {}, status: 'open', createdAt: now(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    s.checkoutUrl = `http://localhost:${PORT}/checkout/${s.id}`;
    db.sessions.set(s.id, s);
    return send(res, 201, s);
  }

  // GET /v1/checkout-sessions/:id
  if (req.method === 'GET' && path.startsWith('/v1/checkout-sessions/')) {
    const s = db.sessions.get(path.split('/')[3]);
    return s ? send(res, 200, s) : send(res, 404, { error: { code: 'not_found', message: 'Checkout session not found' } });
  }

  // POST /v1/qr-codes — create a static or dynamic EMVCo QR
  if (req.method === 'POST' && path === '/v1/qr-codes') {
    const scheme = body.scheme || 'nepalpay_qr';
    if (!['nepalpay_qr', 'fonepay'].includes(scheme)) return send(res, 400, { error: { code: 'invalid_scheme', message: 'scheme must be nepalpay_qr or fonepay' } });
    const type = body.type || (body.amount ? 'dynamic' : 'static');
    if (!['static', 'dynamic'].includes(type)) return send(res, 400, { error: { code: 'invalid_type', message: 'type must be static or dynamic' } });
    if (type === 'dynamic' && (!body.amount || body.amount <= 0)) return send(res, 400, { error: { code: 'invalid_amount', message: 'Dynamic QR needs amount (NPR, > 0) embedded in the QR.' } });
    if (type === 'static' && body.amount) return send(res, 400, { error: { code: 'amount_not_allowed', message: 'Static QR carries no amount — the customer enters it at pay time. Omit amount.' } });
    const qrId = nid('qr');
    const qr = {
      id: qrId, object: 'qr_code', type, scheme, status: 'active',
      merchantId: 'acct_demo',
      merchantName: (body.merchantName || 'Himalayan Store').slice(0, 25),
      merchantCity: (body.merchantCity || 'Kathmandu').slice(0, 15),
      merchantAccountId: body.merchantAccountId || 'acct_demo',
      amount: type === 'dynamic' ? paisa(body.amount) : null,
      currency: 'NPR', orderId: body.orderId || null, metadata: body.metadata || {},
      paymentsCount: 0, paymentId: null, createdAt: now(),
      expiresAt: type === 'dynamic' ? new Date(Date.now() + (Math.min(Math.max(Number(body.expiresInMinutes) || 15, 1), 1440)) * 60 * 1000).toISOString() : null,
    };
    qr.payload = buildEmvPayload({ scheme, type, merchantName: qr.merchantName, merchantCity: qr.merchantCity, merchantAccountId: qr.merchantAccountId, amount: qr.amount, orderId: qr.orderId, qrId });
    qr.qrImageUrl = qrImageUrl(qr.payload);
    qr.displayUrl = `http://localhost:${PORT}/qr/${qr.id}`;
    db.qrCodes.set(qr.id, qr);
    return send(res, 201, qr);
  }

  // GET /v1/qr-codes/:id  |  GET /v1/qr-codes?status=&type=
  if (req.method === 'GET' && path.startsWith('/v1/qr-codes')) {
    const id = path.split('/')[3];
    if (id) {
      const qr = db.qrCodes.get(id);
      if (!qr) return send(res, 404, { error: { code: 'not_found', message: 'QR code not found' } });
      qrStatus(qr); return send(res, 200, qr);
    }
    let list = [...db.qrCodes.values()];
    if (u.searchParams.get('type')) list = list.filter((q) => q.type === u.searchParams.get('type'));
    if (u.searchParams.get('status')) list = list.filter((q) => qrStatus(q) === u.searchParams.get('status'));
    return send(res, 200, { qrCodes: list.slice(-20).reverse() });
  }

  // POST /v1/qr-codes/:id/deactivate
  if (req.method === 'POST' && /^\/v1\/qr-codes\/[^/]+\/deactivate$/.test(path)) {
    const qr = db.qrCodes.get(path.split('/')[3]);
    if (!qr) return send(res, 404, { error: { code: 'not_found', message: 'QR code not found' } });
    if (qr.status === 'paid') return send(res, 400, { error: { code: 'qr_already_paid', message: 'This dynamic QR was already paid and cannot be reactivated.' } });
    qr.status = 'deactivated';
    return send(res, 200, qr);
  }

  // POST /v1/payments  (idempotent — same Idempotency-Key returns the original payment)
  if (req.method === 'POST' && path === '/v1/payments') {
    const key = req.headers['idempotency-key'];
    if (!key) return send(res, 400, { error: { code: 'idempotency_key_required', message: 'Send an Idempotency-Key header — a retry with the same key never charges twice.' } });
    if (db.idempotency.has(key)) { const hit = db.idempotency.get(key); return send(res, hit.status, db.payments.get(hit.paymentId)); }
    // QR pay: resolve method + amount from the scanned QR code.
    let qr = null;
    if (body.qrCodeId) {
      qr = db.qrCodes.get(body.qrCodeId);
      if (!qr) return send(res, 400, { error: { code: 'qr_not_found', message: 'QR code not found' } });
      if (qrStatus(qr) !== 'active') return send(res, 400, { error: { code: 'qr_not_active', message: `This QR code is ${qr.status} and cannot be paid.` } });
      if (body.method && body.method !== qr.scheme) return send(res, 400, { error: { code: 'method_mismatch', message: `QR is ${qr.scheme}, not ${body.method}.` } });
      body.method = qr.scheme;
      if (qr.type === 'dynamic') body.amount = qr.amount;
      if (!body.orderId) body.orderId = qr.orderId;
    }
    const method = body.method;
    if (!METHODS.some((m) => m.id === method)) return send(res, 400, { error: { code: 'invalid_method', message: `method must be one of: ${METHODS.map((m) => m.id).join(', ')}` } });
    const amount = body.checkoutSessionId ? (db.sessions.get(body.checkoutSessionId) || {}).amount : body.amount;
    if (!amount || amount <= 0) return send(res, 400, { error: { code: 'invalid_amount', message: 'amount or a valid checkoutSessionId is required (static QR: customer enters the amount)' } });
    const fee = paisa(amount * (FEE_RATE[method] || 0.02));
    const p = { id: nid('pay'), object: 'payment', checkoutSessionId: body.checkoutSessionId || null, qrCodeId: qr ? qr.id : null, orderId: body.orderId || null, method, amount: paisa(amount), fee, net: paisa(amount - fee), currency: 'NPR', status: 'processing', cardLast4: body.cardLast4 || null, createdAt: now() };
    db.payments.set(p.id, p);
    db.idempotency.set(key, { status: 201, paymentId: p.id });
    const result = await adapters.charge(method, p);
    if (!result.ok) { p.status = 'failed'; p.failure = { code: result.code, message: result.message }; emitWebhook('payment.failed', p); return send(res, 201, p); }
    p.status = 'succeeded'; p.adapterRef = result.adapterRef; p.authCode = result.authCode;
    if (qr) { qr.paymentsCount += 1; qr.paymentId = p.id; if (qr.type === 'dynamic') qr.status = 'paid'; }
    // Double-entry ledger: customer clearing -> merchant pending -> merchant available (minus fee)
    ledgerEntry({ txnId: p.id, account: 'gateway:clearing', debit: p.amount, memo: `charge ${p.id}` });
    ledgerEntry({ txnId: p.id, account: 'merchant:acct_demo:pending', credit: p.amount, memo: `charge ${p.id}` });
    ledgerEntry({ txnId: p.id, account: 'merchant:acct_demo:pending', debit: p.amount, memo: `settle ${p.id}` });
    ledgerEntry({ txnId: p.id, account: 'merchant:acct_demo:available', credit: p.net, memo: `settle ${p.id}` });
    ledgerEntry({ txnId: p.id, account: 'gateway:fees', credit: p.fee, memo: `fee ${p.id}` });
    if (p.checkoutSessionId && db.sessions.has(p.checkoutSessionId)) db.sessions.get(p.checkoutSessionId).status = 'complete';
    emitWebhook('payment.succeeded', p);
    return send(res, 201, p);
  }

  // GET /v1/payments/:id  |  GET /v1/payments?limit=
  if (req.method === 'GET' && path.startsWith('/v1/payments')) {
    const id = path.split('/')[3];
    if (id) { const p = db.payments.get(id); return p ? send(res, 200, p) : send(res, 404, { error: { code: 'not_found', message: 'Payment not found' } }); }
    return send(res, 200, { payments: [...db.payments.values()].slice(-(Number(u.searchParams.get('limit')) || 20)).reverse() });
  }

  // POST /v1/payments/:id/refund
  if (req.method === 'POST' && /^\/v1\/payments\/[^/]+\/refund$/.test(path)) {
    const p = db.payments.get(path.split('/')[3]);
    if (!p) return send(res, 404, { error: { code: 'not_found', message: 'Payment not found' } });
    if (p.status !== 'succeeded') return send(res, 400, { error: { code: 'not_refundable', message: 'Only succeeded payments can be refunded' } });
    const amount = paisa(body.amount || p.amount);
    if (amount <= 0 || amount > p.amount) return send(res, 400, { error: { code: 'invalid_amount', message: 'Refund amount must be > 0 and <= payment amount' } });
    const r = { id: nid('re'), object: 'refund', paymentId: p.id, amount, currency: 'NPR', status: 'succeeded', createdAt: now() };
    const rr = await adapters.refund(p.method, p, amount);
    r.adapterRef = rr.adapterRef;
    ledgerEntry({ txnId: r.id, account: 'merchant:acct_demo:available', debit: amount, memo: `refund ${r.id}` });
    ledgerEntry({ txnId: r.id, account: 'gateway:clearing', credit: amount, memo: `refund ${r.id}` });
    db.refunds.set(r.id, r); emitWebhook('refund.succeeded', r);
    return send(res, 201, r);
  }

  // GET /v1/ledger, /v1/balances, /v1/webhook-events, /v1/merchants/me
  if (req.method === 'GET' && path === '/v1/ledger') return send(res, 200, { ledger: db.ledger.slice(-50).reverse() });
  if (req.method === 'GET' && path === '/v1/balances') return send(res, 200, { balances: { available: balance('merchant:acct_demo:available'), pending: balance('merchant:acct_demo:pending'), feesCollected: balance('gateway:fees') }, currency: 'NPR' });
  if (req.method === 'GET' && path === '/v1/webhook-events') return send(res, 200, { events: db.webhooks.slice(-20).reverse() });
  if (req.method === 'GET' && path === '/v1/merchants/me') return send(res, 200, db.merchants[0]);

  return send(res, 404, { error: { code: 'not_found', message: `No route ${req.method} ${path}` } });
});

function checkoutHtml(s) {
  const methods = METHODS.filter((m) => s.methods.includes(m.id)).map((m) => `<button onclick="pay('${m.id}')">${m.name} — ${(m.feeRate * 100).toFixed(1)}% fee</button>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay NPR ${s.amount} — NepPay Gateway</title><style>body{font-family:system-ui;max-width:480px;margin:40px auto;padding:0 16px}button{display:block;width:100%;margin:8px 0;padding:14px;font-size:16px;cursor:pointer}#out{white-space:pre-wrap;background:#f4f4f4;padding:12px;margin-top:16px}</style></head><body><h2>NepPay Gateway — Checkout</h2><p>Order: <b>${s.orderId || '—'}</b><br>Amount: <b>NPR ${s.amount.toFixed(2)}</b></p>${methods}<div id="out">Pick a method to pay (sandbox — no real money).</div><script>async function pay(m){const r=await fetch('/v1/payments',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':'pk_test_neppay_demo','Idempotency-Key':'web-'+Date.now()},body:JSON.stringify({checkoutSessionId:'${s.id}',method:m})});const j=await r.json();document.getElementById('out').textContent=JSON.stringify(j,null,2);}</script></body></html>`;
}

function qrHtml(qr) {
  const amountLine = qr.type === 'dynamic'
    ? `<p>Amount: <b>NPR ${qr.amount.toFixed(2)}</b> (fixed — in the QR)</p>`
    : `<p>Static QR — no amount in the code. Enter an amount to pay:</p><input id="amt" type="number" min="1" step="0.01" placeholder="Amount in NPR" style="padding:10px;width:100%;font-size:16px">`;
  const canPay = qr.status === 'active';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${qr.merchantName} — NepPay QR</title><style>body{font-family:system-ui;max-width:480px;margin:40px auto;padding:0 16px;text-align:center}img{max-width:320px;width:100%}button{width:100%;margin-top:12px;padding:14px;font-size:16px;cursor:pointer}code{word-break:break-all;font-size:12px;text-align:left;display:block;background:#f4f4f4;padding:10px}#out{white-space:pre-wrap;background:#f4f4f4;padding:12px;margin-top:16px;text-align:left}</style></head><body><h2>${qr.merchantName}</h2><p>${qr.merchantCity} · ${qr.scheme === 'fonepay' ? 'FonePay' : 'NEPALPAY'} QR · ${qr.type} · <b>${qr.status}</b>${qr.expiresAt ? '<br>Expires: ' + qr.expiresAt : ''}</p><img src="${qr.qrImageUrl}" alt="QR code"><p>Scan with any EMVCo QR app, or pay below (sandbox — no real money).</p>${amountLine}${canPay ? `<button onclick="pay()">Pay with ${qr.scheme === 'fonepay' ? 'FonePay' : 'NEPALPAY'} QR</button>` : `<p>This QR can no longer be paid.</p>`}<div id="out"></div><details><summary>EMVCo payload</summary><code>${qr.payload}</code></details><script>async function pay(){const amt=document.getElementById('amt');const body={qrCodeId:'${qr.id}'};if(amt&&amt.value)body.amount=Number(amt.value);const r=await fetch('/v1/payments',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':'pk_test_neppay_demo','Idempotency-Key':'qr-'+Date.now()},body:JSON.stringify(body)});document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2);}</script></body></html>`;
}

server.listen(PORT, () => console.log(`NepPay Gateway sandbox on http://localhost:${PORT}  (health: /health, methods: /v1/methods)`));
module.exports = { server, db, buildEmvPayload, crc16ccitt };
