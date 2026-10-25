// Sandbox smoke tests — run: npm test  (server must NOT already be running on 8788;
// the test boots the server on a random port itself is not supported here, so
// start the server first in another terminal: node server.js, then node test.js)
'use strict';
const BASE = process.env.BASE || 'http://localhost:8788';
const KEY = 'pk_test_neppay_demo';
let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } }
async function j(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
(async () => {
  const h = await j('GET', '/health'); check('health ok', h.body.ok === true);
  const m = await j('GET', '/v1/methods'); check('7 methods listed', (m.body.methods || []).length === 7, JSON.stringify(m.body));
  const noKey = await fetch(BASE + '/v1/payments'); check('unauthenticated rejected', noKey.status === 401);
  const cs = await j('POST', '/v1/checkout-sessions', { amount: 500, orderId: 'ORDER-1', customer: { name: 'Test Buyer' } });
  check('checkout session created', cs.status === 201 && cs.body.id.startsWith('cs_') && cs.body.checkoutUrl.includes('/checkout/'), JSON.stringify(cs.body));
  const key = 'test-' + Date.now();
  const p1 = await j('POST', '/v1/payments', { checkoutSessionId: cs.body.id, method: 'nepalpay_qr' }, { 'Idempotency-Key': key });
  check('payment succeeded', p1.body.status === 'succeeded' && p1.body.fee > 0 && p1.body.net === p1.body.amount - p1.body.fee, JSON.stringify(p1.body));
  const p2 = await j('POST', '/v1/payments', { checkoutSessionId: cs.body.id, method: 'nepalpay_qr' }, { 'Idempotency-Key': key });
  check('idempotent retry returns same payment', p2.body.id === p1.body.id, JSON.stringify(p2.body));
  const bad = await j('POST', '/v1/payments', { amount: 1313, method: 'fonepay' }, { 'Idempotency-Key': 'test-fail-' + Date.now() });
  check('amount 1313 mock-fails', bad.body.status === 'failed');
  const ref = await j('POST', `/v1/payments/${p1.body.id}/refund`, { amount: 100 });
  check('refund succeeded', ref.status === 201 && ref.body.amount === 100, JSON.stringify(ref.body));
  const bal = await j('GET', '/v1/balances');
  check('balances reflect net minus refund', bal.body.balances.available === p1.body.net - 100, JSON.stringify(bal.body));
  const wh = await j('GET', '/v1/webhook-events');
  check('webhook events logged with signature', (wh.body.events || []).some((e) => e.signature && e.signature.startsWith('sha256=')), JSON.stringify(wh.body));

  // --- QR codes: static + dynamic (EMVCo) ---
  function crc16(s) { let c = 0xffff; for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i) << 8; for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, '0'); }
  function tlv(s) { const o = {}; let i = 0; while (i + 4 <= s.length) { const t = s.slice(i, i + 2), l = parseInt(s.slice(i + 2, i + 4), 10); if (i + 4 + l > s.length) break; o[t] = s.slice(i + 4, i + 4 + l); i += 4 + l; } return o; }
  function validEmv(payload) { const root = tlv(payload); return root['00'] === '01' && payload.slice(-4) === crc16(payload.slice(0, -4)); }
  const sq = await j('POST', '/v1/qr-codes', { type: 'static', scheme: 'nepalpay_qr' });
  check('static QR created, no amount, valid EMVCo+CRC', sq.status === 201 && sq.body.amount === null && sq.body.expiresAt === null && validEmv(sq.body.payload) && tlv(sq.body.payload)['01'] === '11' && !('54' in tlv(sq.body.payload)) && sq.body.payload.toLowerCase().includes('nepalpay') && sq.body.displayUrl.includes('/qr/'), JSON.stringify(sq.body));
  const dq = await j('POST', '/v1/qr-codes', { type: 'dynamic', scheme: 'fonepay', amount: 250, orderId: 'ORDER-QR-1' });
  check('dynamic QR created, amount embedded, expires', dq.status === 201 && dq.body.amount === 250 && tlv(dq.body.payload)['01'] === '12' && tlv(dq.body.payload)['54'] === '250.00' && !!dq.body.expiresAt && validEmv(dq.body.payload), JSON.stringify(dq.body));
  const dqNoAmt = await j('POST', '/v1/qr-codes', { type: 'dynamic', scheme: 'nepalpay_qr' });
  check('dynamic QR without amount rejected', dqNoAmt.status === 400, JSON.stringify(dqNoAmt.body));
  const sqAmt = await j('POST', '/v1/qr-codes', { type: 'static', amount: 100 });
  check('static QR with amount rejected', sqAmt.status === 400, JSON.stringify(sqAmt.body));
  const qp1 = await j('POST', '/v1/payments', { qrCodeId: dq.body.id }, { 'Idempotency-Key': 'test-qr-dyn-' + Date.now() });
  check('dynamic QR paid (amount from QR, single-use)', qp1.body.status === 'succeeded' && qp1.body.amount === 250 && qp1.body.qrCodeId === dq.body.id, JSON.stringify(qp1.body));
  const qp2 = await j('POST', '/v1/payments', { qrCodeId: dq.body.id }, { 'Idempotency-Key': 'test-qr-dyn2-' + Date.now() });
  check('dynamic QR cannot be paid twice', qp2.status === 400 && qp2.body.error.code === 'qr_not_active', JSON.stringify(qp2.body));
  const qs1 = await j('POST', '/v1/payments', { qrCodeId: sq.body.id, amount: 100 }, { 'Idempotency-Key': 'test-qr-st1-' + Date.now() });
  const qs2 = await j('POST', '/v1/payments', { qrCodeId: sq.body.id, amount: 50 }, { 'Idempotency-Key': 'test-qr-st2-' + Date.now() });
  check('static QR reusable with customer-entered amounts', qs1.body.status === 'succeeded' && qs1.body.amount === 100 && qs2.body.status === 'succeeded' && qs2.body.amount === 50, JSON.stringify({ qs1: qs1.body, qs2: qs2.body }));
  const sqGet = await j('GET', `/v1/qr-codes/${sq.body.id}`);
  check('static QR shows 2 payments, still active', sqGet.body.paymentsCount === 2 && sqGet.body.status === 'active', JSON.stringify(sqGet.body));
  const page = await fetch(BASE + `/qr/${sq.body.id}`);
  check('QR display page renders', page.status === 200 && (await page.text()).includes('Himalayan Store'));
  const deact = await j('POST', `/v1/qr-codes/${sq.body.id}/deactivate`, {});
  check('static QR deactivated', deact.body.status === 'deactivated', JSON.stringify(deact.body));
  const qp3 = await j('POST', '/v1/payments', { qrCodeId: sq.body.id, amount: 10 }, { 'Idempotency-Key': 'test-qr-st3-' + Date.now() });
  check('deactivated QR cannot be paid', qp3.status === 400, JSON.stringify(qp3.body));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL test crashed', e); process.exit(1); });
