import _path_setup  # noqa: F401  (puts the plugin directory on sys.path)
"""End-to-end wiring test: model HTTP call -> artifact -> authoritative terminal -> delivery.

Scope: the model is a loopback OpenAI-compatible server and the BFF is a loopback stand-in, so this
is *code-level* integration evidence, not a sandbox run and not a real model. It proves the real
entry (run_turn_delivery) captures the predecessor, calls the model, persists the terminal the
consumer later classifies, and delivers with the frozen predecessor.
"""

import json
import os
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from baymax_delivery.completion_hook import CompletionConsumer
from baymax_delivery.delivery_outbox import DeliveryOutbox
from baymax_delivery.run_turn_delivery import ModelUnavailable, OpenAICompatibleModel, run_turn

ENDPOINT = 'https://baymax-bff-sandbox.shaoke.com/graphql'


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
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='baymax-turn-')
        self.root = Path(self.tmp.name)
        self.state = self.root / 'state.sqlite'
        with closing(sqlite3.connect(self.state)) as db, db:
            db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,display_kind TEXT)')
        self.outbox = DeliveryOutbox(self.root / 'outbox.sqlite')
        self.consumer = CompletionConsumer(self.state, self.root / 'intents.sqlite', 'unit-session',
                                           self.outbox, transport=None)
        self.prompts = []

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                self.server.seen = body
                reply = {'choices': [{'message': {'content': 'BUSINESS OUTPUT: 42 items reconciled'}}],
                         'usage': {'total_tokens': 17}}
                data = json.dumps(reply).encode()
                self.send_response(200); self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(data))); self.end_headers(); self.wfile.write(data)

            def log_message(self, format, *args):
                pass

        self.model_server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=self.model_server.serve_forever, daemon=True).start()
        os.environ['BAYMAX_MODEL_API_KEY'] = 'unit-test-key'
        self.model = OpenAICompatibleModel('http://127.0.0.1:%d' % self.model_server.server_port, 'unit-model')

    def tearDown(self):
        self.outbox.close()
        self.model_server.shutdown(); self.model_server.server_close()
        self.tmp.cleanup()

    def run_once(self, transport, execution_ref='turn-run:1'):
        self.consumer.transport = transport
        return run_turn(transport=transport, consumer=self.consumer, model=self.model, state_path=self.state,
                        session_id='unit-session', execution_ref=execution_ref, issue_id='42',
                        prompt='Do the business task', artifacts_dir=self.root / 'artifacts', endpoint=ENDPOINT)

    def test_real_model_call_produces_artifact_terminal_and_delivery(self):
        transport = FakeTransport(head='')
        result = self.run_once(transport)
        # 1) the model was really called with the prompt
        seen = getattr(self.model_server, 'seen', {})
        self.assertEqual(seen['model'], 'unit-model')
        self.assertEqual(seen['messages'][0]['content'], 'Do the business task')
        # 2) the business artifact exists and carries the model output
        artifact = json.loads(Path(result['artifact']).read_text())
        self.assertIn('BUSINESS OUTPUT', artifact['output'])
        # 3) the authoritative terminal is in the canonical store and matches the delivery record
        with closing(sqlite3.connect(self.state)) as db:
            row = db.execute('SELECT id, content FROM messages ORDER BY id DESC LIMIT 1').fetchone()
        self.assertEqual(row[1], 'BUSINESS OUTPUT: 42 items reconciled')
        with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db:
            payload = json.loads(db.execute('SELECT payload FROM intents WHERE execution_ref=?',
                                            ('turn-run:1',)).fetchone()[0])
        self.assertEqual(payload['terminal_message_id'], row[0])
        # 4) delivery used the frozen predecessor and registered evidence first
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
            run_turn(transport=transport, consumer=self.consumer, model=self.model, state_path=self.state,
                     session_id='unit-session', execution_ref='turn-run:3', issue_id='42',
                     prompt='x', artifacts_dir=self.root / 'artifacts', endpoint=ENDPOINT)
        self.assertEqual(transport.submitted, [])
        with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db:
            payload = db.execute("SELECT payload FROM intents WHERE execution_ref='turn-run:3'").fetchone()
        self.assertIsNone(payload[0])


if __name__ == '__main__':
    unittest.main()
