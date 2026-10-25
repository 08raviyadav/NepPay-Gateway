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
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL test crashed', e); process.exit(1); });
