// Example merchant app using the NepPay Gateway SDK.
// Android emulator: use 10.0.2.2 (host localhost). iOS simulator / web: localhost.
// Run the gateway first: cd ../../backend && node server.js
import 'package:flutter/material.dart';
import 'package:neppay_gateway/neppay_gateway.dart';

void main() => runApp(const DemoApp());

class DemoApp extends StatelessWidget {
  const DemoApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Himalayan Store — NepPay Gateway demo',
        home: Scaffold(
          appBar: AppBar(title: const Text('Himalayan Store')),
          body: Center(
            child: ElevatedButton(
              child: const Text('Buy Pashmina — NPR 500'),
              onPressed: () async {
                final gw = NepPayGatewayClient(
                    baseUrl: 'http://10.0.2.2:8788', apiKey: 'pk_test_neppay_demo');
                final session = await gw.createCheckoutSession(amount: 500, orderId: 'ORDER-DEMO-1');
                if (!context.mounted) return;
                showModalBottomSheet(
                    context: context,
                    builder: (_) => NepPayCheckoutSheet(client: gw, session: session));
              },
            ),
          ),
        ),
      );
}
