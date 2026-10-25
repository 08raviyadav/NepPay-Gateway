/// NepPay Gateway SDK — one client for Android, iOS, Web and Desktop.
/// The gateway does the hard work (routing, ledger, webhooks); this SDK is
/// a thin typed wrapper over the HTTP API + a checkout bottom sheet.
/// Usage:
///   final gw = NepPayGatewayClient(baseUrl: 'http://10.0.2.2:8788', apiKey: 'pk_test_neppay_demo');
///   final session = await gw.createCheckoutSession(amount: 500, orderId: 'ORDER-1');
///   final payment = await gw.pay(sessionId: session.id, method: 'nepalpay_qr');
library neppay_gateway;

import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

class NepPayGatewayClient {
  NepPayGatewayClient({required this.baseUrl, required this.apiKey});
  final String baseUrl;
  final String apiKey;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      };

  String _newIdempotencyKey() =>
      'sdk-${DateTime.now().millisecondsSinceEpoch}-${Random().nextInt(999999)}';

  Future<Map<String, dynamic>> createCheckoutSession({
    required double amount,
    String? orderId,
    Map<String, dynamic>? customer,
    List<String>? methods,
  }) async {
    final r = await http.post(
      Uri.parse('$baseUrl/v1/checkout-sessions'),
      headers: _headers,
      body: jsonEncode({
        'amount': amount,
        if (orderId != null) 'orderId': orderId,
        if (customer != null) 'customer': customer,
        if (methods != null) 'methods': methods,
      }),
    );
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<List<dynamic>> listMethods() async {
    final r = await http.get(Uri.parse('$baseUrl/v1/methods'), headers: _headers);
    _throwIfError(r);
    return (jsonDecode(r.body) as Map<String, dynamic>)['methods'] as List;
  }

  /// Charges a checkout session. Idempotent: pass your own key to make a
  /// retry safe, or one is generated per call.
  Future<Map<String, dynamic>> pay({
    String? sessionId,
    double? amount,
    required String method,
    String? idempotencyKey,
    String? cardLast4,
  }) async {
    final r = await http.post(
      Uri.parse('$baseUrl/v1/payments'),
      headers: {..._headers, 'Idempotency-Key': idempotencyKey ?? _newIdempotencyKey()},
      body: jsonEncode({
        if (sessionId != null) 'checkoutSessionId': sessionId,
        if (amount != null) 'amount': amount,
        'method': method,
        if (cardLast4 != null) 'cardLast4': cardLast4,
      }),
    );
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getPayment(String id) async {
    final r = await http.get(Uri.parse('$baseUrl/v1/payments/$id'), headers: _headers);
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> refund(String paymentId, {double? amount}) async {
    final r = await http.post(
      Uri.parse('$baseUrl/v1/payments/$paymentId/refund'),
      headers: _headers,
      body: jsonEncode({if (amount != null) 'amount': amount}),
    );
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> balances() async {
    final r = await http.get(Uri.parse('$baseUrl/v1/balances'), headers: _headers);
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// Create a QR code. Static: no amount (customer enters it).
  /// Dynamic: amount is embedded in the EMVCo payload and the QR is single-use.
  Future<Map<String, dynamic>> createQrCode({
    required String type, // 'static' | 'dynamic'
    String scheme = 'nepalpay_qr', // 'nepalpay_qr' | 'fonepay'
    double? amount,
    String? orderId,
    String? merchantName,
    String? merchantCity,
    int? expiresInMinutes,
  }) async {
    final r = await http.post(
      Uri.parse('$baseUrl/v1/qr-codes'),
      headers: _headers,
      body: jsonEncode({
        'type': type,
        'scheme': scheme,
        if (amount != null) 'amount': amount,
        if (orderId != null) 'orderId': orderId,
        if (merchantName != null) 'merchantName': merchantName,
        if (merchantCity != null) 'merchantCity': merchantCity,
        if (expiresInMinutes != null) 'expiresInMinutes': expiresInMinutes,
      }),
    );
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getQrCode(String id) async {
    final r = await http.get(Uri.parse('$baseUrl/v1/qr-codes/$id'), headers: _headers);
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<List<dynamic>> listQrCodes({String? type, String? status}) async {
    final q = [if (type != null) 'type=$type', if (status != null) 'status=$status'].join('&');
    final r = await http.get(Uri.parse('$baseUrl/v1/qr-codes${q.isEmpty ? '' : '?$q'}'), headers: _headers);
    _throwIfError(r);
    return (jsonDecode(r.body) as Map<String, dynamic>)['qrCodes'] as List;
  }

  Future<Map<String, dynamic>> deactivateQrCode(String id) async {
    final r = await http.post(Uri.parse('$baseUrl/v1/qr-codes/$id/deactivate'), headers: _headers, body: '{}');
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  /// Pay a scanned QR. Dynamic: amount comes from the QR. Static: pass amount.
  Future<Map<String, dynamic>> payWithQr({required String qrCodeId, double? amount, String? idempotencyKey}) async {
    final r = await http.post(
      Uri.parse('$baseUrl/v1/payments'),
      headers: {..._headers, 'Idempotency-Key': idempotencyKey ?? _newIdempotencyKey()},
      body: jsonEncode({'qrCodeId': qrCodeId, if (amount != null) 'amount': amount}),
    );
    _throwIfError(r);
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  void _throwIfError(http.Response r) {
    if (r.statusCode >= 400) {
      final b = jsonDecode(r.body) as Map<String, dynamic>;
      throw NepPayGatewayException(
          b['error']?['code']?.toString() ?? 'gateway_error',
          b['error']?['message']?.toString() ?? 'Gateway request failed (${r.statusCode})');
    }
  }
}

class NepPayGatewayException implements Exception {
  NepPayGatewayException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => 'NepPayGatewayException($code): $message';
}

/// Drop-in checkout sheet: shows methods, charges, reports the result.
/// Host apps can also open the hosted checkout URL in a WebView instead.
class NepPayCheckoutSheet extends StatefulWidget {
  const NepPayCheckoutSheet({super.key, required this.client, required this.session});
  final NepPayGatewayClient client;
  final Map<String, dynamic> session;
  @override
  State<NepPayCheckoutSheet> createState() => _NepPayCheckoutSheetState();
}

class _NepPayCheckoutSheetState extends State<NepPayCheckoutSheet> {
  String? _busy, _result;
  Future<void> _pay(String method) async {
    setState(() { _busy = method; _result = null; });
    try {
      final p = await widget.client.pay(sessionId: widget.session['id'] as String, method: method);
      setState(() => _result = p['status'] == 'succeeded'
          ? 'Paid NPR ${p['amount']} via $method.\nPayment ${p['id']} · fee NPR ${p['fee']}'
          : 'Failed: ${p['failure']?['message'] ?? p['status']}');
    } on NepPayGatewayException catch (e) {
      setState(() => _result = 'Error: ${e.message}');
    } finally {
      setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final methods = (widget.session['methods'] as List?)?.cast<String>() ??
        ['nepalpay_qr', 'fonepay', 'npi', 'esewa', 'khalti', 'card'];
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Pay NPR ${widget.session['amount']}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        Text('Order ${widget.session['orderId'] ?? ''} · NepPay Gateway (sandbox)'),
        const SizedBox(height: 16),
        for (final m in methods)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: ElevatedButton(
              onPressed: _busy == null ? () => _pay(m) : null,
              child: Text(_busy == m ? 'Processing…' : 'Pay with $m'),
            ),
          ),
        if (_result != null) ...[const SizedBox(height: 12), Text(_result!)],
      ]),
    );
  }
}
