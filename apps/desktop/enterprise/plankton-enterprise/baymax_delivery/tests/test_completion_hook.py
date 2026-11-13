import _path_setup  # noqa: F401  (puts the plugin directory on sys.path)
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from baymax_delivery.completion_hook import CompletionConsumer
from baymax_delivery.delivery_outbox import DeliveryOutbox

class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.state = self.root / 'state.sqlite'
        with closing(sqlite3.connect(self.state)) as db, db:
            db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,display_kind TEXT)')
        self.outbox = DeliveryOutbox(self.root / 'outbox.sqlite')
        self.consumer = CompletionConsumer(self.state, self.root / 'intents.sqlite', 'unit-session', self.outbox)
        self.context = {'session_id': 'unit-session', 'execution_ref': 'unit-execution:1',
                        'expected_current_delivery_id': ''}
    def tearDown(self): self.outbox.close(); self.temp.cleanup()
    def terminal(self, content='Real isolated terminal record', kind=None):
        with closing(sqlite3.connect(self.state)) as db, db:
            db.execute('INSERT INTO messages(session_id,role,content,display_kind) VALUES(?,?,?,?)', ('unit-session','assistant',content,kind))

    def test_old_end_event_cannot_publish_or_imply_success(self):
        self.consumer.handle('agent:start', self.context)
        self.terminal()
        result = self.consumer.handle('agent:end', {**self.context, 'response':'truncated'})
        self.assertEqual(result['status'], 'awaiting_persisted_terminal')
        self.assertEqual(self.outbox.db.execute('SELECT COUNT(*) FROM queue').fetchone()[0], 0)

    def test_unbound_real_terminal_is_durable_but_does_not_send(self):
        self.consumer.handle('agent:start', self.context); self.terminal()
        result = self.consumer.handle('agent:delivery-ready', {**self.context, 'response':'Real isolated terminal record', 'outcome':'completed'})
        self.assertEqual(result['status'], 'blocked_binding')
        restarted = CompletionConsumer(self.state, self.root / 'intents.sqlite', 'unit-session', self.outbox)
        self.assertEqual(restarted.resume('unit-execution:1')['status'], 'blocked_binding')
        self.assertEqual(self.outbox.db.execute('SELECT COUNT(*) FROM queue').fetchone()[0], 0)
        with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db:
            payload = json.loads(db.execute('SELECT payload FROM intents').fetchone()[0])
            self.assertEqual(payload['terminal_message_id'], 1)
            self.assertEqual(payload['summary'], 'Real isolated terminal record')

    def test_previous_reply_and_unpersisted_reply_cannot_become_new_delivery(self):
        self.terminal('Old reply')
        self.consumer.handle('agent:start', self.context)
        with self.assertRaises(ValueError):
            self.consumer.handle('agent:delivery-ready', {**self.context,'response':'Old reply','outcome':'completed'})
        with self.assertRaises(ValueError):
            self.consumer.handle('agent:delivery-ready', {**self.context,'response':'Not persisted','outcome':'completed'})

    def test_bound_completion_hook_records_before_background_network_writeback(self):
        from types import SimpleNamespace
        binding = SimpleNamespace(execution_ref='unit-execution:1', issue_id='42')
        def forbidden(**kwargs): self.fail('Completion hook must not wait for network writeback')
        self.consumer.transport = SimpleNamespace(issuer=SimpleNamespace(binding=binding, require_binding=lambda:binding), register_evidence=forbidden)
        self.consumer.handle('agent:start',self.context); self.terminal()
        result = self.consumer.handle('agent:delivery-ready',{**self.context,'response':'Real isolated terminal record','outcome':'completed'})
        self.assertEqual(result['status'],'ready_to_writeback')
        self.assertEqual(self.outbox.db.execute('SELECT COUNT(*) FROM queue').fetchone()[0],0)

    def test_confirmed_receipt_remains_confirmed_after_binding_is_removed(self):
        from types import SimpleNamespace
        binding = SimpleNamespace(execution_ref='unit-execution:1', issue_id='42')
        counter = []
        def register(**kwargs): counter.append('evidence'); return {'id':'unit-evidence-' + str(len(counter))}
        def submit(**kwargs): counter.append('submit'); return {'id':'unit-delivery', 'version':kwargs['version']}
        self.consumer.transport = SimpleNamespace(issuer=SimpleNamespace(binding=binding, require_binding=lambda:binding), register_evidence=register, submit_delivery=submit)
        self.consumer.handle('agent:start',self.context); self.terminal()
        self.consumer.handle('agent:delivery-ready',{**self.context,'response':'Real isolated terminal record','outcome':'completed'})
        original = self.consumer.resume('unit-execution:1')
        self.consumer.transport = None
        self.assertEqual(self.consumer.resume('unit-execution:1'),original)
        self.assertEqual(counter,['evidence','evidence','submit'])
        self.assertEqual(self.consumer.pending_runs(),[])

    def test_other_sessions_are_not_exported(self):
        self.assertIsNone(self.consumer.handle('agent:start', {'session_id':'private-other-session','execution_ref':'unknown'}))
        self.assertIsNone(self.consumer.handle('agent:delivery-ready', {'session_id':'private-other-session','response':'Do not export'}))

    def test_summary_stays_within_the_backend_contract_and_full_output_is_evidence(self):
        from types import SimpleNamespace
        binding = SimpleNamespace(execution_ref='unit-execution:1', issue_id='42')
        captured = {}
        def register(**kwargs):
            captured.setdefault('artifacts', []).append(kwargs)
            return {'id': 'unit-evidence-' + str(len(captured['artifacts']))}
        def submit(**kwargs):
            captured['summary'] = kwargs['summary']
            return {'id': 'unit-delivery', 'version': kwargs['version']}
        self.consumer.transport = SimpleNamespace(issuer=SimpleNamespace(binding=binding, require_binding=lambda: binding),
                                                  register_evidence=register, submit_delivery=submit)
        for length in (8000, 8001, 19900, 200000):
            with self.subTest(length=length):
                captured.clear()
                payload = {'execution_ref': 'unit-execution:1', 'session_id': 'unit-session', 'terminal_message_id': 1,
                           'summary': 'x' * length, 'outcome': 'completed'}
                with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db, db:
                    db.execute('INSERT OR REPLACE INTO intents(execution_ref,floor,payload,receipt,predecessor) VALUES(?,?,?,NULL,?)',
                               ('unit-execution:1', 0, json.dumps(payload), ''))
                result = self.consumer.resume('unit-execution:1')
                self.assertEqual(result['status'], 'submitted')
                self.assertLessEqual(len(captured['summary']), 8000)
                if length > 8000:
                    self.assertIn('完整运行终态见证据', captured['summary'])
                else:
                    self.assertEqual(captured['summary'], 'x' * length)
                full = [a for a in captured['artifacts'] if a['name'] == 'runtime-output.txt'][0]['content']
                self.assertEqual(len(full), length)  # the untruncated output is kept as evidence
                with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db, db:
                    db.execute('DELETE FROM intents')
                self.outbox.db.execute('DELETE FROM queue'); self.outbox.db.execute('DELETE FROM uploads'); self.outbox.db.commit()

    def test_lost_ready_event_is_recovered_from_canonical_without_rerunning(self):
        from types import SimpleNamespace
        binding = SimpleNamespace(execution_ref='unit-execution:1', issue_id='42')
        calls = []
        def register(**kwargs): calls.append('evidence'); return {'id': 'unit-evidence-1'}
        def submit(**kwargs):
            calls.append({'outcome': kwargs.get('outcome'), 'unfinished': kwargs.get('unfinished')})
            return {'id': 'unit-delivery', 'version': kwargs['version']}
        self.consumer.transport = SimpleNamespace(issuer=SimpleNamespace(binding=binding, require_binding=lambda: binding),
                                                  register_evidence=register, submit_delivery=submit)
        self.consumer.handle('agent:start', self.context)
        self.terminal('Persisted output but the ready event never arrived')
        recovery = self.consumer.recover_from_canonical('unit-execution:1')
        self.assertEqual(recovery['status'], 'recovered_terminal')
        self.assertEqual(recovery['outcome'], 'unknown')
        self.assertTrue(recovery['requires_reconciliation'])
        delivered = self.consumer.resume('unit-execution:1')
        self.assertEqual(delivered['status'], 'submitted')
        submits = [c for c in calls if isinstance(c, dict)]
        self.assertEqual(submits[0]['outcome'], 'unknown')
        self.assertIn('完成事件丢失', submits[0]['unfinished'][0])
        # A late event for the same run must neither deliver twice nor upgrade the outcome claim.
        late = self.consumer.handle('agent:delivery-ready', {**self.context, 'response': 'Persisted output but the ready event never arrived', 'outcome': 'completed'})
        self.assertEqual(late['status'], 'submitted')
        self.assertEqual(len([c for c in calls if isinstance(c, dict)]), 1)

    def test_two_runs_in_one_session_never_share_the_later_terminal(self):
        """A's completion event is lost; B runs later. A must not adopt B's output."""
        self.consumer.handle('agent:start', self.context)          # run A admitted, event lost
        self.terminal('A terminal never delivered')
        context_b = {**self.context, 'execution_ref': 'unit-execution:2'}
        self.consumer.handle('agent:start', context_b)             # run B admitted after A
        # The newest assistant message now belongs to B's window, not A's.
        result = self.consumer.recover_from_canonical('unit-execution:1')
        self.assertEqual(result['status'], 'ambiguous_terminal')
        self.assertEqual(result['blocked_by'], ['unit-execution:2'])
        self.assertEqual(self.outbox.db.execute('SELECT COUNT(*) FROM queue').fetchone()[0], 0)
        # The later run can still be recovered on its own, and only then does a delivery appear.
        from types import SimpleNamespace
        binding = SimpleNamespace(execution_ref='unit-execution:2', issue_id='42')
        self.consumer.transport = SimpleNamespace(issuer=SimpleNamespace(binding=binding, require_binding=lambda: binding),
                                                  register_evidence=lambda **k: {'id': 'unit-evidence-b'},
                                                  submit_delivery=lambda **k: {'id': 'unit-delivery-b', 'version': k['version']})
        self.terminal('B output owned by run B')
        self.consumer.handle('agent:delivery-ready', {**context_b, 'response': 'B output owned by run B', 'outcome': 'completed'})
        self.consumer.resume('unit-execution:2')
        with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db:
            rows = dict(db.execute('SELECT execution_ref, payload FROM intents').fetchall())
        self.assertIsNone(rows['unit-execution:1'])
        self.assertIsNotNone(rows['unit-execution:2'])
        self.assertEqual(self.outbox.db.execute('SELECT COUNT(*) FROM queue').fetchone()[0], 1)

    def test_summary_budget_is_utf16_units_with_hint(self):
        from baymax_delivery.delivery_outbox import clip_utf16, utf16_len
        # 4001 emoji = 8002 UTF-16 units: clipped by the backend's budget, not Python's len().
        emoji = '😀' * 4001
        clipped = clip_utf16(emoji)
        self.assertLessEqual(utf16_len(clipped), 8000)
        self.assertIn('完整运行终态见证据', clipped)
        mixed = ('字' * 3999) + ('😀' * 10)
        self.assertLessEqual(utf16_len(clip_utf16(mixed)), 8000)
        self.assertEqual(clip_utf16('short'), 'short')

    def test_same_floor_runs_never_share_one_terminal(self):
        """A admitted and interrupted before any new message; B admitted at the same floor.

        Message ids cannot order the runs (both floored on the same id), so A must stay ambiguous
        even after B produces the session's newest assistant message.
        """
        self.consumer.handle('agent:start', self.context)                 # A: floor = latest id (0)
        context_b = {**self.context, 'execution_ref': 'unit-execution:2'}
        self.consumer.handle('agent:start', context_b)                    # B: same floor
        self.terminal('B output for the same floor window')
        self.consumer.handle('agent:delivery-ready', {**context_b, 'response': 'B output for the same floor window', 'outcome': 'completed'})
        with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db:
            floors = dict(db.execute('SELECT execution_ref, floor FROM intents').fetchall())
            seqs = dict(db.execute('SELECT execution_ref, seq FROM intents').fetchall())
        self.assertEqual(floors['unit-execution:1'], floors['unit-execution:2'])
        self.assertLess(seqs['unit-execution:1'], seqs['unit-execution:2'])
        recovered = self.consumer.recover_from_canonical('unit-execution:1')
        self.assertEqual(recovered['status'], 'ambiguous_terminal')
        self.assertEqual(recovered['blocked_by'], ['unit-execution:2'])
        with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db:
            payloads = dict(db.execute('SELECT execution_ref, payload FROM intents').fetchall())
        self.assertIsNone(payloads['unit-execution:1'])
        self.assertIsNotNone(payloads['unit-execution:2'])

    def test_recovery_preserves_a_persisted_failure_marker(self):
        self.consumer.handle('agent:start', self.context)
        self.terminal('Attempt failed', kind='error')
        self.assertEqual(self.consumer.recover_from_canonical('unit-execution:1')['outcome'], 'failed')

    def test_recovery_without_a_new_terminal_stays_blocked(self):
        self.consumer.handle('agent:start', self.context)
        self.terminal('Old reply')
        self.consumer.handle('agent:start', {'session_id': 'unit-session', 'execution_ref': 'unit-execution:2'})
        self.assertEqual(self.consumer.recover_from_canonical('unit-execution:2')['status'], 'no_terminal')
        with closing(sqlite3.connect(self.root / 'intents.sqlite')) as db:
            self.assertIsNone(db.execute("SELECT payload FROM intents WHERE execution_ref='unit-execution:2'").fetchone()[0])
        self.assertEqual(self.consumer.unfinished_runs(), ['unit-execution:1', 'unit-execution:2'])

if __name__ == '__main__': unittest.main()
