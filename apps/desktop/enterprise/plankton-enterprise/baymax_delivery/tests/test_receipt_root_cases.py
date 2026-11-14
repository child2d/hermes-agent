"""ROOT-CAUSE receipt cases, run under a hermetic home and a SQLite/open audit.

Bootstrap must precede every application import: HOME / HERMES_HOME / TMPDIR are re-pointed at this
run's own scratch root, every inherited HERMES_*/PLANKTON_* is cleared, and audited I/O outside the
root aborts the process instead of touching the live profile (state.db, config, .env, auth).

The cases here are the reviewer's RED list: a real backlog must not hand back the older row, a failed
final write must never deliver the intermediate one and must deliver the exact final after retry, a
persisted partial uid must not revive a failed/overflowed/refused run, an agent flush stamp is the
only agent-owned terminal identity, and the default (no delivery hook) path performs zero uid queries.
"""

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

# Hermetic cases: they re-point HOME/HERMES_HOME/TMPDIR and install a process-wide audit hook, so they
# own their interpreter. They run automatically from ``test_hermetic_receipt_runner.py`` (a normal
# pytest entry that spawns this module in a clean child process) — never mind manually setting env.
_HERMETIC_FLAG = 'BAYMAX_HERMETIC_RECEIPT'
if os.environ.get(_HERMETIC_FLAG) != '1':
    raise unittest.SkipTest(f'hermetic receipt cases run in their own process (see test_hermetic_receipt_runner); '
                            f'set {_HERMETIC_FLAG}=1 to run directly')

# Repo root from this file's location: apps/desktop/enterprise/plankton-enterprise/baymax_delivery/tests/
REPO = Path(__file__).resolve().parents[6]
SCRATCH = Path(os.environ.get('BAYMAX_TEST_SCRATCH') or tempfile.gettempdir()).resolve()
ROOT = Path(tempfile.mkdtemp(prefix='hermetic-receipt-', dir=SCRATCH)).resolve()
for _part in ('home', 'hermes', 'tmp'):
    (ROOT / _part).mkdir(parents=True, exist_ok=True)
for _key in list(os.environ):
    if _key.startswith(('HERMES_', 'PLANKTON_')):
        del os.environ[_key]
os.environ.update(HOME=str(ROOT / 'home'), HERMES_HOME=str(ROOT / 'hermes'),
                  TMPDIR=str(ROOT / 'tmp'), PYTHONDONTWRITEBYTECODE='1')

VIOLATIONS = []
CONNECTIONS = []


def _within(path) -> bool:
    try:
        return Path(path).resolve().is_relative_to(ROOT)
    except OSError:
        return False


def _audit(event, args):
    if event == 'sqlite3.connect':
        raw = str(args[0])
        if raw.startswith('file:'):
            from urllib.parse import unquote, urlparse

            raw = unquote(urlparse(raw).path)
        if raw != ':memory:' and not _within(raw):
            VIOLATIONS.append(['sqlite3.connect', raw])
            raise SystemExit('ISOLATION VIOLATION: sqlite3.connect ' + raw)
        CONNECTIONS.append(raw)
    elif event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)):
        path = Path(os.fsdecode(args[0])).resolve()
        flags = args[2] if len(args) > 2 else 0
        writing = isinstance(flags, int) and bool(
            flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        sensitive = (path.name in {'state.db', 'config.yaml', 'config.yml', '.env', 'auth.json'}
                     or path.name.startswith('state.db-') or 'sessions' in path.parts)
        if (writing or sensitive) and not path.is_relative_to(ROOT):
            VIOLATIONS.append(['open', str(path)])
            raise SystemExit('ISOLATION VIOLATION: open ' + str(path))


sys.addaudithook(_audit)
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / 'apps/desktop/enterprise/plankton-enterprise'))

import dotenv

dotenv.load_dotenv = lambda *a, **k: False
dotenv.find_dotenv = lambda *a, **k: ''
import hermes_cli.env_loader

hermes_cli.env_loader.load_hermes_dotenv = lambda *a, **k: None

import sqlite3

from gateway.config import GatewayConfig
from gateway.run_turn_persistence import GatewayTurnPersistenceMixin
from gateway.session import AsyncSessionStore, SessionStore
from hermes_state import SessionDB

from baymax_delivery.completion_hook import CompletionConsumer
from baymax_delivery.delivery_outbox import DeliveryOutbox

DB_PATH = ROOT / 'hermes' / 'state.db'
_real_db_init = SessionDB.__init__


def _isolated_db_init(self, *args, **kwargs):
    supplied = args[0] if args else kwargs.get('db_path')
    if supplied is not None and not _within(supplied):
        VIOLATIONS.append(['SessionDB.__init__', str(supplied)])
        raise SystemExit('ISOLATION VIOLATION: SessionDB ' + str(supplied))
    if args:
        args = (DB_PATH,) + args[1:]
    else:
        kwargs['db_path'] = DB_PATH
    _real_db_init(self, *args, **kwargs)
    assert Path(self.db_path).resolve() == DB_PATH, self.db_path


SessionDB.__init__ = _isolated_db_init


class ReceiptRootCases(unittest.TestCase):
    def setUp(self):
        self.sid = 'root-case'
        self.store = SessionStore(ROOT / 'sessions', GatewayConfig())
        self.db = self.store._db_for_session_id(self.sid)
        assert Path(self.db.db_path).resolve() == DB_PATH
        self.db.ensure_session(self.sid, 'test')
        self.outbox = DeliveryOutbox(ROOT / 'outbox.sqlite3')

    def tearDown(self):
        self.outbox.close()
        try:
            self.store.close_all_db_handles()
        except Exception:
            pass

    # -- harness -------------------------------------------------------------
    def _persist(self, *, messages, response='FINAL ANSWER', agent_persisted=False,
                 delivery_enabled=True, run_ref='run-1', overflow=False, failed_early=False,
                 failure_reason=None, terminal_receipt=None, session_id=None,
                 interrupted=None, completed=None, failed=None):
        async def _noop(*a, **k):
            return None

        sid = session_id or self.sid
        obj = SimpleNamespace(
            async_session_store=AsyncSessionStore(self.store), _session_db=self.db,
            _hmwa_user_transcript_entry=lambda *a, **k: {'role': 'user', 'content': 'question'},
            _hmwa_close_failed_turn=_noop, _hmwa_failed_turn_notice=lambda r: 'failed',
            _hmwa_retain_content_policy_refused_turn=_noop,
            _refresh_agent_cache_message_count=_noop)
        bound = GatewayTurnPersistenceMixin._hmwa_persist_turn_transcript.__get__(obj)
        # The receipt resolver is its own method; bind it to this host too.
        obj._hmwa_agent_owned_receipt = GatewayTurnPersistenceMixin._hmwa_agent_owned_receipt.__get__(obj)
        import inspect

        accepted = inspect.signature(bound).parameters
        extra = {'delivery_enabled': delivery_enabled, 'run_ref': run_ref}
        # Heads that predate these keywords are still exercised as themselves (behavioural RED).
        extra = {k: v for k, v in extra.items() if k in accepted}
        result = {'history_offset': 0, 'last_prompt_tokens': 0, 'agent_persisted': agent_persisted}
        if failure_reason:
            result['failure_reason'] = failure_reason
        if terminal_receipt is not None:
            result['terminal_receipt'] = terminal_receipt
        # Real run termination state, exactly as the streaming finalizer reads it.
        if interrupted is not None:
            result['interrupted'] = interrupted
        if completed is not None:
            result['completed'] = completed
        if failed is not None:
            result['failed'] = failed
        return asyncio.run(bound(
            event=SimpleNamespace(message_id=None, internal=False, reply_expected=True),
            source=SimpleNamespace(platform=None, user_id='1', chat_id='', chat_type=''),
            session_entry=SimpleNamespace(session_id=sid, session_key='root-key'),
            session_key='root-key', agent_result=result, agent_messages=messages,
            prepared=SimpleNamespace(history=[], persist_user_display_kind=None),
            response=response, agent_failed_early=failed_early,
            hidden_reasoning_incomplete=False, is_context_overflow_failure=overflow,
            **extra))

    @staticmethod
    def _as_pair(receipt):
        """(row_id, session_id) for either shape: old heads only ever returned a bare id."""
        if isinstance(receipt, tuple):
            return int(receipt[0]), receipt[1]
        return int(receipt), None

    def _consumer(self):
        return CompletionConsumer(DB_PATH, ROOT / 'intents.sqlite3', self.sid, self.outbox)

    def _consumer_for(self, sid):
        return CompletionConsumer(DB_PATH, ROOT / 'intents.sqlite3', sid, self.outbox)

    def _admit(self, run_ref):
        consumer = self._consumer()
        consumer.handle('agent:start', {'session_id': self.sid, 'execution_ref': run_ref,
                                        'expected_current_delivery_id': ''})
        return consumer

    def _deliver(self, receipt, run_ref='run-1', consumer=None):
        consumer = consumer or self._consumer()
        consumer.handle('agent:delivery-ready', {
            'session_id': receipt['session_id'], 'execution_ref': run_ref,
            'canonical_message_id': receipt['message_id'], 'terminal_run': receipt['run'],
            'terminal_source': receipt['source'], 'response': 'display text',
            'outcome': 'completed'})
        payload = consumer.payload_of(run_ref)
        return json.loads(payload) if payload else None

    def _rows(self, sid=None):
        return [(r['id'], r['role'], r['content']) for r in self.db.get_messages(sid or self.sid)]

    # -- ROOT #1: old backlog must not answer for this call ------------------
    def test_old_backlog_returns_this_calls_row(self):
        store = self.store
        real_write = store._append_transcript_message
        state = {'fail': True}

        def flaky(session_id, message):
            if state['fail']:
                state['fail'] = False
                raise sqlite3.OperationalError('injected transient fault')
            return real_write(session_id, message)

        store._append_transcript_message = flaky
        try:
            self.assertIsNone(store.append_to_transcript(self.sid, {'role': 'assistant',
                                                                    'content': 'OLDER'}))
            receipt = store.append_to_transcript(self.sid, {'role': 'assistant',
                                                            'content': 'THIS CALL'})
        finally:
            store._append_transcript_message = real_write
        self.assertIsNotNone(receipt, 'a real backlog must not swallow this call')
        row_id, session_id = self._as_pair(receipt)
        self.assertEqual(session_id or self.sid, self.sid)
        landed = next(content for rid, _role, content in self._rows() if rid == row_id)
        self.assertEqual(landed, 'THIS CALL', 'receipt names an older queued item')

    # -- ROOT #2: failed final write, then retry delivers the exact final ----
    def test_failed_final_write_delivers_nothing_then_exact_final(self):
        messages = [{'role': 'user', 'content': 'question'},
                    {'role': 'assistant', 'content': 'INTERMEDIATE'},
                    {'role': 'assistant', 'content': 'FINAL ANSWER'}]
        store = self.store
        real_write = store._append_transcript_message

        def fail_final(session_id, message):
            if message.get('content') == 'FINAL ANSWER':
                raise sqlite3.OperationalError('injected final-write failure')
            return real_write(session_id, message)

        store._append_transcript_message = fail_final
        try:
            receipt = self._persist(messages=messages, run_ref='run-1')
        finally:
            store._append_transcript_message = real_write
        self.assertIsNone(receipt, 'a queued/failed terminal must not report a receipt')
        self.assertIsNone(self._consumer().payload_of('run-1'))

        # Same run retried: the run is admitted first (a terminal must be newer than its admission),
        # then its own terminal commits — only then is it deliverable.
        consumer = self._admit('run-2')
        retry = self._persist(messages=messages, run_ref='run-2')
        self.assertIsNotNone(retry)
        row = next(r for r in self.db.get_messages(self.sid) if r['id'] == retry['message_id'])
        self.assertEqual(row['content'], 'FINAL ANSWER')
        payload = self._deliver(retry, run_ref='run-2', consumer=consumer)
        self.assertEqual(payload['summary'], 'FINAL ANSWER')

    def test_tool_call_as_last_step_has_no_receipt(self):
        messages = [{'role': 'user', 'content': 'question'},
                    {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'c1'}]}]
        self.assertIsNone(self._persist(messages=messages))

    # -- ROOT #3: persisted partial uid must not revive a non-terminal run ---
    def _persisted_partial(self):
        row_id = self.db.append_message(self.sid, 'assistant', 'PARTIAL')
        uid = next(r['message_uid'] for r in self.db.get_messages(self.sid) if r['id'] == row_id)
        return [{'role': 'user', 'content': 'question'},
                {'role': 'assistant', 'content': 'PARTIAL', 'message_uid': uid}]

    def test_persisted_partial_uid_never_receipts_on_failure_overflow_or_refusal(self):
        for kwargs in ({'overflow': True}, {'failed_early': True},
                       {'failure_reason': 'content_policy_blocked'}):
            messages = self._persisted_partial()
            self.assertIsNone(self._persist(messages=messages, agent_persisted=True, **kwargs),
                              f'partial uid revived for {kwargs}')

    # -- ROOT #4: agent-owned terminal identity comes from the real flush boundary ---------
    def _real_flush(self, messages, sid=None):
        """Run the agent's REAL commit boundary: _db_flush_write -> append_messages_batch -> stamps."""
        from agent.session_persistence import _db_flush_row, _db_flush_write

        agent = SimpleNamespace(session_id=sid or self.sid, _session_db=self.db)
        batch_rows, batch_msgs = [], []
        for msg in messages:
            batch_rows.append(_db_flush_row(agent, msg, False))
            batch_msgs.append(msg)
        _db_flush_write(agent, batch_rows, batch_msgs, messages)
        return messages

    def test_agent_flush_produces_the_committed_identity(self):
        from gateway.run_turn_runner import _committed_terminal_identity

        consumer = self._admit('run-flush')
        messages = self._real_flush([{'role': 'user', 'content': 'question'},
                                     {'role': 'assistant', 'content': 'AGENT FINAL'}])
        identity = _committed_terminal_identity(messages, 0)
        self.assertIsNotNone(identity, 'a committed terminal must yield an identity')
        self.assertIsInstance(identity['message_id'], int)
        self.assertEqual(identity['session_id'], self.sid,
                         'flush must stamp the owning session for the committed row')
        landed = next(r for r in self.db.get_messages(self.sid) if r['id'] == identity['message_id'])
        self.assertEqual(landed['content'], 'AGENT FINAL')

        receipt = self._persist(messages=messages, agent_persisted=True, run_ref='run-flush',
                                terminal_receipt=identity)
        self.assertIsNotNone(receipt)
        self.assertEqual(receipt['message_id'], identity['message_id'])
        self.assertEqual(receipt['session_id'], self.sid)
        self.assertEqual(receipt['source'], 'agent_flush_marker')
        self.assertEqual(receipt['run'], 'run-flush')
        payload = self._deliver(receipt, run_ref='run-flush', consumer=consumer)
        self.assertEqual(payload['summary'], 'AGENT FINAL')

    def test_interrupted_run_never_delivers_its_committed_partial(self):
        from gateway.run_turn_runner import _committed_terminal_identity

        consumer = self._admit('run-int')
        messages = self._real_flush([{'role': 'user', 'content': 'question'},
                                     {'role': 'assistant', 'content': 'PARTIAL INTERRUPTED'}])
        # The partial really is committed, so the identity exists — but the RUN did not complete.
        identity = _committed_terminal_identity(messages, 0)
        self.assertIsNotNone(identity)
        receipt = self._persist(messages=messages, agent_persisted=True, run_ref='run-int',
                                terminal_receipt=identity,
                                interrupted=True, completed=False)
        self.assertIsNone(receipt, 'an interrupted run must not produce a completed receipt')
        self.assertIsNone(consumer.payload_of('run-int'), 'no completed payload for an interrupted run')

    def test_terminal_state_gates_every_receipt_shape_for_both_owners(self):
        """Same combination for gateway-owned and agent-owned persistence.

        A partial that really landed may stay in the transcript, but no receipt may leave the
        persistence call and no completed payload may reach the outbox. The reply path itself keeps
        working (persist returns normally; notify does not raise).
        """
        from gateway.run_turn_runner import _committed_terminal_identity

        cases = {
            'interrupted': {'interrupted': True, 'completed': False, 'failed': False},
            'completed_false': {'completed': False},
            'success': {},
        }
        for owner in (False, True):
            for label, state in cases.items():
                run_ref = f'run-{owner}-{label}'
                with self.subTest(owner=owner, state=label):
                    sid = f'root-{owner}-{label}'
                    self.db.ensure_session(sid, 'test')
                    consumer = self._consumer_for(sid)
                    consumer.handle('agent:start', {'session_id': sid, 'execution_ref': run_ref,
                                                    'expected_current_delivery_id': ''})
                    messages = [{'role': 'user', 'content': 'question'},
                                {'role': 'assistant', 'content': f'PARTIAL {label}'}]
                    terminal_receipt = None
                    if owner:
                        # agent-owned: the REAL flush boundary commits and stamps the partial.
                        self._real_flush(messages, sid=sid)
                        terminal_receipt = _committed_terminal_identity(messages, 0)
                        self.assertIsNotNone(terminal_receipt)
                    receipt = self._persist(messages=messages, agent_persisted=owner,
                                            run_ref=run_ref, session_id=sid,
                                            terminal_receipt=terminal_receipt,
                                            **state)
                    rows = self._rows(sid)
                    if state:
                        self.assertTrue(any(f'PARTIAL {label}' == (c or '') for _i, _r, c in rows),
                                        'the partial may stay in the transcript')
                        self.assertIsNone(receipt, f'{label} must not produce a receipt (owner={owner})')
                        self.assertIsNone(consumer.payload_of(run_ref),
                                          f'{label} must not produce a completed payload (owner={owner})')
                    else:
                        self.assertIsNotNone(receipt, f'normal success must receipt (owner={owner})')
                        payload = self._deliver(receipt, run_ref=run_ref, consumer=consumer)
                        self.assertEqual(payload['summary'], f'PARTIAL {label}')

    def test_failed_run_receipt_does_not_touch_the_main_reply(self):
        consumer = self._admit('run-failed')
        messages = self._real_flush([{'role': 'user', 'content': 'question'},
                                     {'role': 'assistant', 'content': 'PARTIAL'}])
        receipt = self._persist(messages=messages, agent_persisted=True, run_ref='run-failed',
                                failed_early=True)
        self.assertIsNone(receipt)
        self.assertIsNone(consumer.payload_of('run-failed'))

    def test_agent_owned_without_marker_or_uid_returns_none(self):
        messages = [{'role': 'user', 'content': 'question'},
                    {'role': 'assistant', 'content': 'AGENT FINAL'}]
        self.assertIsNone(self._persist(messages=messages, agent_persisted=True))

    # -- ROOT #5: default path performs no delivery-specific query -----------
    def test_default_path_queries_no_uid(self):
        calls = []
        original = self.db.message_id_by_uid

        def spy(session_id, message_uid):
            calls.append(message_uid)
            return original(session_id, message_uid)

        self.db.message_id_by_uid = spy
        try:
            messages = self._persisted_partial()
            receipt = self._persist(messages=messages, agent_persisted=True,
                                    delivery_enabled=False)
        finally:
            self.db.message_id_by_uid = original
        self.assertIsNone(receipt)
        self.assertEqual(calls, [], 'default (no delivery hook) path resolved uids')


if __name__ == '__main__':
    unittest.main()
