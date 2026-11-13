"""End-to-end wiring test: model HTTP call -> artifact -> authoritative terminal -> delivery.

Scope: the model is a loopback OpenAI-compatible server and the BFF is a loopback stand-in, so this
is *code-level* integration evidence, not a sandbox run and not a real model. The canonical store is
the repository's real ``SessionDB`` (not a hand-written table), so the terminal write exercises the
real schema and its maintenance path.
"""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import _path_setup
from baymax_delivery.completion_hook import CompletionConsumer
from baymax_delivery.delivery_outbox import DeliveryOutbox
from baymax_delivery.run_turn_delivery import ModelUnavailable, OpenAICompatibleModel, run_turn

sys.path.insert(0, str(_path_setup.REPO_ROOT))
from hermes_state import SessionDB

ENDPOINT = 'https://baymax-bff-sandbox.shaoke.com/graphql'
SESSION = 'unit-session'


class FakeTransport:
    """Duck-typed host transport: state read + evidence + submit, recording what was sent."""

    def __init__(self, head='', execution_ref='turn-run:1'):
        from types import SimpleNamespace
        self.head = head
        self.submitted = []
        self.evidence = []
        binding = SimpleNamespace(issue_id='42', grant_id='11111111-1111-4111-8111-111111111111',
                                  subject='plankton:unit', delegator_id='7', execution_ref=execution_ref)
        self.issuer = SimpleNamespace(binding=binding, require_binding=lambda: binding)

    def read_state(self, *, endpoint, issue_id):
        return {'issueId': issue_id, 'expectedCurrentDeliveryId': self.head}

    def register_evidence(self, *, endpoint, issue_id, name, content, request_key):
        record = {'id': '22222222-2222-4222-8222-222222222222', 'name': name,
                  'sha256': __import__('hashlib').sha256(content.encode()).hexdigest()}
        self.evidence.append(record)
        return record

    def submit_delivery(self, **kwargs):
        self.submitted.append(kwargs)
        return {'id': '33333333-3333-4333-8333-333333333333', 'version': kwargs['version'],
                'execution_ref': kwargs['execution_ref']}


class TurnDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='baymax-turn-')
        self.root = Path(self.tmp.name)
        self.store = SessionDB(db_path=self.root / 'state.db')
        self.store.create_session(SESSION, 'test')
        self.outbox = DeliveryOutbox(self.root / 'outbox.sqlite')
        self.consumer = CompletionConsumer(self.root / 'state.db', self.root / 'intents.sqlite', SESSION,
                                           self.outbox, transport=None)

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                self.server.seen = body
                reply = {'choices': [{'message': {'content': 'BUSINESS OUTPUT: 42 items reconciled'}}],
                         'usage': {'total_tokens': 17}}
                data = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.model_server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=self.model_server.serve_forever, daemon=True).start()
        os.environ['BAYMAX_MODEL_API_KEY'] = 'unit-test-key'
        self.model = OpenAICompatibleModel(f'http://127.0.0.1:{self.model_server.server_port}',
                                           'unit-model', allow_plaintext_endpoint=True)

    def tearDown(self):
        self.outbox.close()
        try:
            self.store.close()
        except Exception:
            pass
        self.model_server.shutdown()
        self.model_server.server_close()
        self.tmp.cleanup()

    def run_once(self, transport, execution_ref='turn-run:1'):
        self.consumer.transport = transport
        return run_turn(transport=transport, consumer=self.consumer, model=self.model, store=self.store,
                        session_id=SESSION, execution_ref=execution_ref, issue_id='42',
                        prompt='Do the business task', artifacts_dir=self.root / 'artifacts',
                        admission_path=self.root / 'admissions.sqlite', endpoint=ENDPOINT)

    def test_real_model_call_produces_artifact_terminal_and_delivery(self):
        transport = FakeTransport(head='')
        result = self.run_once(transport)
        seen = getattr(self.model_server, 'seen', {})
        self.assertEqual(seen['model'], 'unit-model')
        self.assertEqual(seen['messages'][0]['content'], 'Do the business task')
        artifact = json.loads(Path(result['artifact']).read_text())
        self.assertIn('BUSINESS OUTPUT', artifact['output'])
        rows = [row for row in self.store.get_messages(SESSION) if row.get('role') == 'assistant']
        self.assertEqual(rows[-1]['content'], 'BUSINESS OUTPUT: 42 items reconciled')
        self.assertEqual(rows[-1]['id'], result['terminalMessageId'])
        payload = json.loads(self.consumer.payload_of('turn-run:1'))
        self.assertEqual(payload['terminal_message_id'], rows[-1]['id'])
        self.assertEqual(result['predecessor'], '')
        self.assertEqual(transport.submitted[0]['expected_current_delivery_id'], '')
        self.assertEqual(len(transport.evidence), 2)
        self.assertEqual(result['delivery']['status'], 'submitted')

    def test_predecessor_is_captured_before_the_run_and_reused(self):
        transport = FakeTransport(head='44444444-4444-4444-8444-444444444444', execution_ref='turn-run:2')
        result = self.run_once(transport, execution_ref='turn-run:2')
        self.assertEqual(result['predecessor'], '44444444-4444-4444-8444-444444444444')
        self.assertEqual(transport.submitted[0]['expected_current_delivery_id'],
                         '44444444-4444-4444-8444-444444444444')

    def test_missing_model_credential_blocks_before_any_delivery(self):
        os.environ.pop('BAYMAX_MODEL_API_KEY', None)
        transport = FakeTransport(head='')
        self.consumer.transport = transport
        with self.assertRaises(ModelUnavailable):
            run_turn(transport=transport, consumer=self.consumer, model=self.model, store=self.store,
                     session_id=SESSION, execution_ref='turn-run:3', issue_id='42',
                     prompt='x', artifacts_dir=self.root / 'artifacts',
                     admission_path=self.root / 'admissions.sqlite', endpoint=ENDPOINT)
        self.assertEqual(transport.submitted, [])
        self.assertIsNone(self.consumer.payload_of('turn-run:3'))


if __name__ == '__main__':
    unittest.main()
