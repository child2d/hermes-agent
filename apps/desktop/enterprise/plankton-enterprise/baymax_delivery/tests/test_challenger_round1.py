"""Challenger round-1 regressions (P1-1..P1-4, P2-6/P2-7 scope).

Every case here is a RED test on the previous head:
  * the model client followed a cross-origin redirect and handed the bearer to the new origin;
  * the one-shot entry re-ran the model for a repeated execution;
  * the terminal write used reduced SQL that a real ``messages`` table rejects (``timestamp``);
  * ``agent:delivery-ready`` identified the terminal by display text, and recovery adopted a
    mid-turn tool-call row.
"""

import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from _path_setup import PACKAGE_ROOT, REPO_ROOT

from baymax_delivery.completion_hook import CompletionConsumer
from baymax_delivery.delivery_outbox import DeliveryOutbox
from baymax_delivery.run_turn_delivery import OpenAICompatibleModel, TurnRejected, run_turn

sys.path.insert(0, str(REPO_ROOT))
from hermes_state import SessionDB


class _Recorder(BaseHTTPRequestHandler):
    auth_headers = []
    status = 200
    location = None
    body = b'{"choices":[{"message":{"content":"answer"}}]}'

    def do_POST(self):
        self.__class__.auth_headers.append(self.headers.get('authorization'))
        self.rfile.read(int(self.headers.get('content-length') or 0))
        if self.__class__.location:
            self.send_response(302)
            self.send_header('location', self.__class__.location)
            self.send_header('content-length', '0')
            self.end_headers()
            return
        self.send_response(self.__class__.status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(self.__class__.body)))
        self.end_headers()
        self.wfile.write(self.__class__.body)

    def log_message(self, *args):
        pass


def _server(payload=b'{"choices":[{"message":{"content":"answer"}}]}', location=None):
    handler = type('H', (_Recorder,), {'auth_headers': [], 'body': payload, 'location': location})
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, handler, f'http://127.0.0.1:{server.server_address[1]}'


class ModelTransportPolicy(unittest.TestCase):
    def test_plaintext_endpoint_is_refused_by_default(self):
        with self.assertRaises(ValueError):
            OpenAICompatibleModel('http://127.0.0.1:9/v1', 'm')

    def test_cross_origin_redirect_never_receives_the_credential(self):
        target, target_handler, target_url = _server()
        source, source_handler, source_url = _server(location=target_url + '/v1/chat/completions')
        try:
            model = OpenAICompatibleModel(source_url + '/v1', 'unit', allow_plaintext_endpoint=True)
            os.environ['BAYMAX_MODEL_API_KEY'] = 'unit-test-key'
            with self.assertRaises(Exception):
                model.complete('hello')
            self.assertEqual([h for h in target_handler.auth_headers if h], [])
            self.assertTrue(any(h for h in source_handler.auth_headers))
        finally:
            source.shutdown()
            source.server_close()
            target.shutdown()
            target.server_close()

    def test_direct_success_still_parses(self):
        server, _, url = _server()
        try:
            model = OpenAICompatibleModel(url + '/v1', 'unit', allow_plaintext_endpoint=True)
            os.environ['BAYMAX_MODEL_API_KEY'] = 'unit-test-key'
            text, _ = model.complete('hello')
            self.assertEqual(text, 'answer')
            self.assertEqual(model.calls, 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_injected_transport_still_cannot_bounce_to_another_origin(self):
        """Even a caller-supplied opener may not return a response from a different origin."""
        server, _, url = _server()
        try:
            def opener(request, timeout):
                raise AssertionError('unused')
            model = OpenAICompatibleModel(url + '/v1', 'unit', allow_plaintext_endpoint=True, opener=opener)
            os.environ['BAYMAX_MODEL_API_KEY'] = 'unit-test-key'
            with self.assertRaises(Exception):
                model.complete('hello')
        finally:
            server.shutdown()
            server.server_close()


class _StubModel:
    def __init__(self):
        self.calls = 0

    def complete(self, prompt):
        self.calls += 1
        return 'answer-for-' + prompt, {}


class _StateTransport:
    def __init__(self, head=''):
        self.head = head

    def read_state(self, *, endpoint, issue_id):
        return {'expectedCurrentDeliveryId': self.head}


class EntryGate(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='baymax-r1-'))
        self.store = SessionDB(db_path=self.root / 'state.db')
        self.store.create_session('s1', 'test')
        self.outbox = DeliveryOutbox(self.root / 'outbox.sqlite3')
        self.consumer = CompletionConsumer(self.root / 'state.db', self.root / 'intents.sqlite3',
                                           's1', self.outbox)

    def tearDown(self):
        self.outbox.close()
        try:
            self.store.close()
        except Exception:
            pass

    def _run(self, model=None, session='s1', execution='run-1', issue='5001'):
        return run_turn(transport=_StateTransport(), consumer=self.consumer, model=model or _StubModel(),
                        store=self.store, session_id=session, execution_ref=execution, issue_id=issue,
                        prompt='hello', artifacts_dir=self.root / 'artifacts',
                        admission_path=self.root / 'admissions.sqlite3')

    def _terminal_rows(self, session='s1'):
        return [row for row in self.store.get_messages(session) if row.get('role') == 'assistant']

    def test_a_repeated_execution_does_not_run_the_business_again(self):
        model = _StubModel()
        first = self._run(model=model)
        second = self._run(model=model)
        self.assertEqual(first['status'], 'completed')
        self.assertEqual(second['status'], 'blocked_already_started')
        self.assertEqual(model.calls, 1)
        self.assertEqual(len(self._terminal_rows()), 1)

    def test_concurrent_duplicates_execute_once(self):
        model = _StubModel()
        results = []
        lock = threading.Lock()

        def worker():
            outcome = self._run(model=model)
            with lock:
                results.append(outcome['status'])

        threads = [threading.Thread(target=worker) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results.count('completed'), 1)
        self.assertEqual(model.calls, 1)
        self.assertEqual(len(self._terminal_rows()), 1)

    def test_a_wrong_session_is_rejected_before_the_model(self):
        model = _StubModel()
        outcome = self._run(model=model, session='other-session')
        self.assertEqual(outcome['status'], 'blocked_consumer_refused')
        self.assertEqual(model.calls, 0)
        self.assertEqual(self._terminal_rows('other-session'), [])

    def test_terminal_uses_the_real_schema_and_reads_back(self):
        outcome = self._run()
        message_id = outcome['terminalMessageId']
        row = next(r for r in self.store.get_messages('s1') if r['id'] == message_id)
        self.assertEqual(row['content'], 'answer-for-hello')
        self.assertIsNotNone(row.get('timestamp'))


class TerminalIdentity(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='baymax-r1-id-'))
        self.store = SessionDB(db_path=self.root / 'state.db')
        self.store.create_session('s1', 'test')
        self.outbox = DeliveryOutbox(self.root / 'outbox.sqlite3')
        self.consumer = CompletionConsumer(self.root / 'state.db', self.root / 'intents.sqlite3',
                                           's1', self.outbox)
        self.consumer.handle('agent:start', {'session_id': 's1', 'execution_ref': 'run-1',
                                             'expected_current_delivery_id': ''})

    def tearDown(self):
        self.outbox.close()
        try:
            self.store.close()
        except Exception:
            pass

    def test_footer_or_reasoning_display_text_does_not_break_acceptance(self):
        message_id = self.store.append_message('s1', 'assistant', 'canonical body', display_kind='final')
        result = self.consumer.handle('agent:delivery-ready', {
            'session_id': 's1', 'execution_ref': 'run-1', 'canonical_message_id': message_id,
            'response': 'canonical body\n\nfooter · 0.4s · reasoning…', 'outcome': 'completed'})
        self.assertEqual(result['status'], 'blocked_binding')  # accepted, only the transport is absent
        payload = json.loads(self.consumer.payload_of('run-1'))
        self.assertEqual(payload['summary'], 'canonical body')
        self.assertEqual(payload['terminal_message_id'], message_id)

    def test_event_without_message_id_is_refused(self):
        self.store.append_message('s1', 'assistant', 'body', display_kind='final')
        result = self.consumer.handle('agent:delivery-ready', {
            'session_id': 's1', 'execution_ref': 'run-1', 'response': 'body', 'outcome': 'completed'})
        self.assertEqual(result['status'], 'blocked_terminal_identity')

    def test_a_tool_call_row_is_not_a_terminal(self):
        message_id = self.store.append_message('s1', 'assistant', '', tool_calls=[{'id': 'c1'}])
        with self.assertRaises(ValueError):
            self.consumer.handle('agent:delivery-ready', {
                'session_id': 's1', 'execution_ref': 'run-1', 'canonical_message_id': message_id,
                'response': 'anything', 'outcome': 'completed'})

    def test_recovery_without_association_stays_pending(self):
        self.store.append_message('s1', 'assistant', '', tool_calls=[{'id': 'c1'}])
        self.assertEqual(self.consumer.recover_from_canonical('run-1')['status'],
                         'pending_terminal_association')

    def test_recovery_after_explicit_association_uses_the_associated_row(self):
        message_id = self.store.append_message('s1', 'assistant', 'real terminal', display_kind='final')
        with self.assertRaises(ValueError):
            self.consumer.associate_terminal('run-1', self.store.append_message(
                's1', 'assistant', '', tool_calls=[{'id': 'c2'}]))
        self.consumer.associate_terminal('run-1', message_id)
        outcome = self.consumer.recover_from_canonical('run-1')
        self.assertEqual(outcome['status'], 'recovered_terminal')
        self.assertEqual(outcome['outcome'], 'unknown')
        payload = json.loads(self.consumer.payload_of('run-1'))
        self.assertEqual(payload['terminal_message_id'], message_id)


if __name__ == '__main__':
    unittest.main(verbosity=2)
