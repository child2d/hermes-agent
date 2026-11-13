import _path_setup  # noqa: F401  (puts the plugin directory on sys.path)
"""Real RSA and loopback HTTP tests. This is not a formal runtime or live grant."""
import base64
import hashlib
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes
from baymax_delivery.runtime_bridge import Binding, RuntimeIssuer, SandboxTransport, ENDPOINT

class RuntimeBridgeTests(unittest.TestCase):
    def setUp(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.binding = Binding('42', '11111111-1111-4111-8111-111111111111', 'plankton:isolated-test', '7', 'unit-run:1', int(time.time()) + 180)
        self.issuer = RuntimeIssuer(self.key, self.binding, 'unit-runtime-issuer')

    def test_real_rsa_assertion_is_scoped_and_expires_soon(self):
        token = self.issuer.issue('submit')
        h, p, s = token.split('.')
        decode = lambda value: base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
        self.key.public_key().verify(decode(s), (h + '.' + p).encode(), padding.PKCS1v15(), hashes.SHA256())
        claims = json.loads(decode(p))
        self.assertEqual(claims['aud'], ENDPOINT)
        self.assertEqual(claims['operations'], ['submit'])
        self.assertEqual(claims['execution_ref'], 'unit-run:1')
        self.assertLessEqual(claims['exp'] - claims['iat'], 120)
        self.assertEqual(claims['issue_id'], '42')

    def test_unknown_binding_cannot_sign_or_send(self):
        issuer = RuntimeIssuer(self.key, None, 'unit-runtime-issuer')
        with self.assertRaises(ValueError): issuer.issue('submit')
        transport = SandboxTransport(issuer, opener=lambda *a, **kw: self.fail('Must not send'))
        with self.assertRaises(ValueError):
            transport.register_evidence(endpoint=ENDPOINT, issue_id='42', name='unit.txt', content='data', request_key='unit-key')

    def test_runtime_cannot_issue_acceptance_or_close_permission(self):
        for operation in ('review', 'grant', 'close'):
            with self.assertRaises(ValueError): self.issuer.issue(operation)

    def test_real_http_requests_and_durable_resume_reuse_evidence(self):
        from baymax_delivery.delivery_outbox import DeliveryOutbox
        import tempfile
        from pathlib import Path
        calls, uploads = [], {}
        class Server(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((body, self.headers.get('Authorization')))
                variables = body['variables']
                if 'registerIssueDeliveryEvidence' in body['query']:
                    key = variables['requestKey']
                    uploads.setdefault(key, {'id': '22222222-2222-4222-8222-222222222222', 'name': variables['name'], 'sha256': hashlib.sha256(variables['content'].encode()).hexdigest()})
                    reply = {'data': {'registerIssueDeliveryEvidence': uploads[key]}}
                elif 'issueDeliveryReceipt' in body['query']:
                    # The failed submission never committed: server truth has no receipt for the key.
                    reply = {'data': {'issueDeliveryReceipt': {'issueId': variables['issueId'], 'operation': variables['operation'],
                        'requestKey': variables['requestKey'], 'found': False, 'receipt': None}}}
                elif len([c for c, _ in calls if 'submitIssueDelivery' in c['query']]) == 1:
                    reply = {'errors': [{'message': 'Explicit HTTP fixture failure'}]}
                else:
                    reply = {'data': {'submitIssueDelivery': {'id': '33333333-3333-4333-8333-333333333333', 'version': 'unit-v1',
                                                              'execution_ref': 'unit-run:1'}}}
                data = json.dumps(reply).encode(); self.send_response(200); self.end_headers(); self.wfile.write(data)
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def loopback(request, timeout):
            self.assertEqual(request.full_url, ENDPOINT)
            return urlopen(Request(f'http://127.0.0.1:{server.server_port}/graphql', request.data, dict(request.headers)), timeout=timeout)
        try:
            transport = SandboxTransport(self.issuer, opener=loopback)
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'outbox.sqlite'
                outbox = DeliveryOutbox(path)
                key = outbox.enqueue(endpoint=ENDPOINT, issue_id='42', execution_ref='unit-run:1', version='unit-v1', summary='Explicit isolated execution output', unfinished=['Real sandbox loop not verified'], artifacts=[{'name': 'unit.txt', 'content': 'Unit evidence'}], expected_current_delivery_id='')
                with self.assertRaises(RuntimeError): outbox.resume(key, transport)
                outbox.close(); outbox = DeliveryOutbox(path)
                receipt = outbox.resume(key, transport); outbox.close()
                self.assertEqual(receipt['version'], 'unit-v1')
                self.assertEqual(len(uploads), 1)
                self.assertEqual(len(calls), 5)
                self.assertTrue(all(header.startswith('Bearer ') for _, header in calls))
                self.assertIn('issueDeliveryReceipt', calls[3][0]['query'])
                self.assertIn('submitIssueDelivery', calls[4][0]['query'])
                last = calls[4][0]['variables']['input']
                self.assertEqual(last['unfinished'], ['Real sandbox loop not verified'])
                self.assertEqual(last['executionRef'], 'unit-run:1')
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_receipt_payload_must_match_every_client_field(self):
        """A receipt for the same key/run/version but different content must never clear pending."""
        receipt_payload = {'issueId': '42', 'requestKey': 'unit-key', 'executionRef': 'unit-run:1',
                           'version': 'unit-v1', 'summary': 'RIGHT', 'unfinished': None,
                           'evidenceIds': ['22222222-2222-4222-8222-222222222222'],
                           'outcome': 'completed', 'expectedCurrentDeliveryId': ''}
        received = []
        class Server(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                reply = {'data': {'issueDeliveryReceipt': {'issueId': '42', 'operation': 'submit', 'requestKey': 'unit-key',
                    'found': True, 'receipt': {'subject': 'plankton:isolated-test', 'operation': 'submit',
                    'request_key': 'unit-key', 'payload': receipt_payload,
                    'response': {'id': '33333333-3333-4333-8333-333333333333', 'version': 'unit-v1', 'execution_ref': 'unit-run:1'}}}}}
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(reply).encode())
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def loopback(request, timeout):
            return urlopen(Request(f'http://127.0.0.1:{server.server_port}/graphql', request.data, dict(request.headers)), timeout=timeout)
        try:
            transport = SandboxTransport(self.issuer, opener=loopback)
            base = dict(receipt_payload)
            good = transport.read_receipt(endpoint=ENDPOINT, issue_id='42', operation='submit', request_key='unit-key', expected=base)
            self.assertEqual(good['version'], 'unit-v1')
            for field, wrong in (('summary', 'WRONG'), ('evidenceIds', []), ('unfinished', ['x']),
                                 ('outcome', 'failed'), ('expectedCurrentDeliveryId', '44444444-4444-4444-8444-444444444444'),
                                 ('version', 'unit-v2')):
                with self.subTest(field=field):
                    with self.assertRaises(RuntimeError) as raised:
                        transport.read_receipt(endpoint=ENDPOINT, issue_id='42', operation='submit',
                                               request_key='unit-key', expected={**base, field: wrong})
                    self.assertIn('keep pending', str(raised.exception))
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_non_boolean_found_flag_is_a_protocol_error(self):
        """Only found === false means "no receipt"; anything else must keep pending."""
        cases = {'missing': {}, 'null': {'found': None}, 'string': {'found': 'false'}, 'number': {'found': 0}}
        state = {'body': {}}
        class Server(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('content-length') or 0))
                reply = {'data': {'issueDeliveryReceipt': {'issueId': '42', 'operation': 'submit',
                                                          'requestKey': 'unit-key', **state['body']}}}
                data = json.dumps(reply).encode()
                self.send_response(200); self.send_header('content-length', str(len(data))); self.end_headers()
                self.wfile.write(data)
            def log_message(self, format, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def loopback(request, timeout):
            return urlopen(Request(f'http://127.0.0.1:{server.server_port}/graphql', request.data, dict(request.headers)), timeout=timeout)
        try:
            transport = SandboxTransport(self.issuer, opener=loopback)
            for name, body in cases.items():
                with self.subTest(case=name):
                    state['body'] = body
                    with self.assertRaises(RuntimeError) as raised:
                        transport.read_receipt(endpoint=ENDPOINT, issue_id='42', operation='submit',
                                               request_key='unit-key', expected={'version': 'unit-v1'})
                    self.assertIn('keep pending', str(raised.exception))
            state['body'] = {'found': False, 'receipt': None}
            self.assertIsNone(transport.read_receipt(endpoint=ENDPOINT, issue_id='42', operation='submit',
                                                     request_key='unit-key', expected={'version': 'unit-v1'}))
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_different_issue_never_reaches_network(self):
        transport = SandboxTransport(self.issuer, opener=lambda *a, **kw: self.fail('Must not send'))
        with self.assertRaises(ValueError):
            transport.register_evidence(endpoint=ENDPOINT, issue_id='43', name='unit.txt', content='data', request_key='unit-key')

if __name__ == '__main__': unittest.main()
