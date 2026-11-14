"""Delivery chain with a REAL HookRegistry: run -> persist -> hook -> consumer.

The receipt cases elsewhere call the consumer directly to test its contract. That leaves the wiring
between persistence and an installed hook untested — which is exactly where a partial run used to be
published before the terminal gate. Here a real ``HookRegistry`` holds one real handler that feeds a
real ``CompletionConsumer``, and the persistence call is the only thing that runs it: five terminal
states x two persistence owners, plus the optional-boundary fault injection (provider and uid lookup
must never turn a finished turn into an error reply).

Hermetic: HOME/HERMES_HOME/TMPDIR are fixed before the application imports and an audit hook refuses
any file/SQLite access outside this run's own scratch root.
"""

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

if os.environ.get('BAYMAX_HERMETIC_RECEIPT') != '1':
    raise unittest.SkipTest('hermetic delivery-chain cases need BAYMAX_HERMETIC_RECEIPT=1 in their own process')

REPO = Path(__file__).resolve().parents[6]
SCRATCH = Path(os.environ.get('BAYMAX_TEST_SCRATCH') or tempfile.gettempdir()).resolve()
ROOT = Path(tempfile.mkdtemp(prefix='hook-chain-', dir=SCRATCH)).resolve()
for _part in ('home', 'hermes', 'tmp'):
    (ROOT / _part).mkdir(parents=True, exist_ok=True)
for _key in list(os.environ):
    if _key.startswith(('HERMES_', 'PLANKTON_')):
        del os.environ[_key]
os.environ.update(HOME=str(ROOT / 'home'), HERMES_HOME=str(ROOT / 'hermes'),
                  TMPDIR=str(ROOT / 'tmp'), PYTHONDONTWRITEBYTECODE='1')


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
            raise SystemExit('ISOLATION VIOLATION: sqlite3.connect ' + raw)
    elif event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)):
        path = Path(os.fsdecode(args[0])).resolve()
        flags = args[2] if len(args) > 2 else 0
        writing = isinstance(flags, int) and bool(
            flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        sensitive = (path.name in {'state.db', 'config.yaml', '.env', 'auth.json'}
                     or path.name.startswith('state.db-') or 'sessions' in path.parts)
        if (writing or sensitive) and not path.is_relative_to(ROOT):
            raise SystemExit('ISOLATION VIOLATION: open ' + str(path))


sys.addaudithook(_audit)
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / 'apps/desktop/enterprise/plankton-enterprise'))

import dotenv

dotenv.load_dotenv = lambda *a, **k: False
import hermes_cli.env_loader

hermes_cli.env_loader.load_hermes_dotenv = lambda *a, **k: None

from gateway.config import GatewayConfig
from gateway.hooks import HookRegistry
from gateway.run_turn_persistence import GatewayTurnPersistenceMixin
from gateway.session import AsyncSessionStore, SessionStore
from hermes_state import SessionDB
from hermes_state_errors import StateDbReplacedError

from baymax_delivery.completion_hook import CompletionConsumer
from baymax_delivery.delivery_outbox import DeliveryOutbox

DB_PATH = ROOT / 'hermes' / 'state.db'
_real_db_init = SessionDB.__init__


def _isolated_db_init(self, *args, **kwargs):
    supplied = args[0] if args else kwargs.get('db_path')
    if supplied is not None and not _within(supplied):
        raise SystemExit('ISOLATION VIOLATION: SessionDB ' + str(supplied))
    if args:
        args = (DB_PATH,) + args[1:]
    else:
        kwargs['db_path'] = DB_PATH
    _real_db_init(self, *args, **kwargs)
    assert Path(self.db_path).resolve() == DB_PATH


SessionDB.__init__ = _isolated_db_init

STATES = {
    'normal': {},
    'interrupted': {'interrupted': True, 'completed': False, 'failed': False},
    'completed_false': {'completed': False},
    'failed': {'failed': True},
    'hidden_incomplete': {'hidden_reasoning_incomplete': True},
}


class HookDeliveryChain(unittest.TestCase):
    def setUp(self):
        self.store = SessionStore(ROOT / 'sessions', GatewayConfig())
        self.outbox = DeliveryOutbox(ROOT / 'outbox.sqlite3')
        self.registry = HookRegistry()
        self.sids = {}

    def tearDown(self):
        self.outbox.close()
        try:
            self.store.close_all_db_handles()
        except Exception:
            pass

    # -- harness -------------------------------------------------------------
    def _wire(self, run_ref, state):
        """Install the real consumer as the profile's delivery handler for one session/run."""
        sid = f'chain-{run_ref}'
        self.sids[run_ref] = sid
        db = self.store._db_for_session_id(sid)
        db.ensure_session(sid, 'test')
        consumer = CompletionConsumer(DB_PATH, ROOT / 'intents.sqlite3', sid, self.outbox)
        consumer.handle('agent:start', {'session_id': sid, 'execution_ref': run_ref,
                                        'expected_current_delivery_id': ''})
        seen = []

        def handle(event_type, context):
            seen.append(dict(context or {}))
            return consumer.handle('agent:delivery-ready', context)

        self.registry._handlers.setdefault('agent:delivery-ready', []).append(handle)
        provider_holder = {'fn': None}
        host = SimpleNamespace(
            async_session_store=AsyncSessionStore(self.store), _session_db=db,
            hooks=self.registry, delivery_terminal_receipt_provider=None,
            _hmwa_user_transcript_entry=lambda *a, **k: {'role': 'user', 'content': 'question'},
            _hmwa_close_failed_turn=self._noop, _hmwa_failed_turn_notice=lambda r: 'failed',
            _hmwa_retain_content_policy_refused_turn=self._noop,
            _refresh_agent_cache_message_count=self._noop,
        )
        host._hmwa_agent_owned_receipt = GatewayTurnPersistenceMixin._hmwa_agent_owned_receipt.__get__(host)
        return host, db, consumer, seen, provider_holder

    async def _noop(self, *a, **k):
        return None

    def _run(self, *, run_ref, owner, state, messages, terminal_receipt=None, provider=None,
             sessions=None, response='FINAL ANSWER', prewired=None):
        host, db, consumer, seen, _ = prewired or self._wire(run_ref, state)
        host.delivery_terminal_receipt_provider = provider
        bound = GatewayTurnPersistenceMixin._hmwa_persist_turn_transcript.__get__(host)
        sid = self.sids[run_ref]
        agent_result = {'history_offset': 0, 'last_prompt_tokens': 0, 'agent_persisted': owner}
        if terminal_receipt is not None:
            agent_result['terminal_receipt'] = terminal_receipt
        agent_result.update(state)
        receipt = asyncio.run(bound(**self._filtered(bound, dict(
            event=SimpleNamespace(message_id=None, internal=False, reply_expected=True),
            source=SimpleNamespace(platform=None, user_id='1', chat_id='', chat_type=''),
            session_entry=SimpleNamespace(session_id=sid, session_key='chain-key'),
            session_key='chain-key', agent_result=agent_result, agent_messages=messages,
            prepared=SimpleNamespace(history=[], persist_user_display_kind=None,
                                     message_text='question'),
            response=response, agent_failed_early=bool(state.get('failed')),
            hidden_reasoning_incomplete=bool(state.get('hidden_reasoning_incomplete')),
            is_context_overflow_failure=False,
            run_ref=run_ref,
            hook_ctx={'execution_ref': run_ref, 'platform': 'local', 'user_id': '1',
                      'session_id': sid, 'message': 'question',
                      'expected_current_delivery_id': ''},
        ))))
        payload = consumer.payload_of(run_ref)
        return receipt, payload, seen, db

    @staticmethod
    def _filtered(fn, kwargs):
        """Pass only the keywords this head accepts, so a pre-fix head runs its real code."""
        import inspect

        accepted = inspect.signature(fn).parameters
        return {key: value for key, value in kwargs.items() if key in accepted}

    def _flush(self, db, sid, messages):
        from agent.session_persistence import _db_flush_row, _db_flush_write

        agent = SimpleNamespace(session_id=sid, _session_db=db)
        rows, msgs = [], []
        for msg in messages:
            rows.append(_db_flush_row(agent, msg, False))
            msgs.append(msg)
        _db_flush_write(agent, rows, msgs, messages)

    # -- five states x two owners, through the real hook ---------------------
    def test_terminal_gate_holds_for_every_state_and_owner(self):
        from gateway.run_turn_runner import _committed_terminal_identity

        for owner in (False, True):
            for label, state in STATES.items():
                run_ref = f'{owner}-{label}'
                with self.subTest(owner=owner, state=label):
                    messages = [{'role': 'user', 'content': 'question'},
                                {'role': 'assistant', 'content': f'PARTIAL {label}'}]
                    terminal_receipt = None
                    prewired = None
                    if owner:
                        prewired = self._wire(run_ref, state)
                        _host, db, _consumer, _seen, _p = prewired
                        # Real flush first, so the row really commits; then the SAME wired host runs
                        # the persist call (one handler, one admission).
                        self._flush(db, self.sids[run_ref], messages)
                        terminal_receipt = _committed_terminal_identity(messages, 0)
                        self.assertIsNotNone(terminal_receipt)
                    receipt, payload, seen, db = self._run(
                        run_ref=run_ref, owner=owner, state=state, messages=messages,
                        terminal_receipt=terminal_receipt, prewired=prewired)
                    if label == 'normal':
                        self.assertIsNotNone(receipt, 'normal terminal must yield a receipt')
                        self.assertEqual(len(seen), 1, 'exactly one delivery-ready for a normal run')
                        self.assertIsNotNone(payload)
                        data = json.loads(payload)
                        self.assertEqual(data['terminal_message_id'], receipt['message_id'])
                        self.assertEqual(data['session_id'], receipt['session_id'])
                        self.assertEqual(data['outcome'], 'completed')
                    else:
                        self.assertIsNone(receipt, f'{label} must not yield a receipt')
                        self.assertEqual(seen, [], f'{label} must not emit delivery-ready')
                        self.assertIsNone(payload, f'{label} must not publish a payload')

    def test_hook_ctx_keeps_the_admission_fields(self):
        receipt, _payload, seen, _db = self._run(
            run_ref='ctx', owner=False, state={},
            messages=[{'role': 'user', 'content': 'question'},
                      {'role': 'assistant', 'content': 'FINAL ANSWER'}])
        self.assertIsNotNone(receipt)
        self.assertEqual(len(seen), 1)
        ctx = seen[0]
        for key in ('execution_ref', 'platform', 'user_id', 'session_id', 'message',
                    'expected_current_delivery_id', 'terminal_run', 'canonical_message_id'):
            self.assertIn(key, ctx, f'hook_ctx lost {key}')

    # -- optional boundary: never turn a finished turn into an error reply ---
    def test_provider_failures_do_not_break_the_turn(self):
        def boom(**kwargs):
            raise KeyError('missing receipt source')

        def sqlite_boom(**kwargs):
            raise sqlite3.OperationalError('database is locked')

        for provider in (boom, sqlite_boom):
            _receipt, payload, seen, _db = self._run(
                run_ref='prov', owner=False, state={},
                messages=[{'role': 'user', 'content': 'question'},
                          {'role': 'assistant', 'content': 'FINAL ANSWER'}],
                provider=provider)
            # The turn is still normal (nothing escaped); only the notification is skipped.
            self.assertIsNone(payload)
            self.assertEqual(seen, [], 'a failing provider must not reach the hook')

    def test_uid_lookup_failures_do_not_break_the_turn(self):
        for error in (StateDbReplacedError('db replaced'), RuntimeError('unexpected'), KeyError('uid')):
            run_ref = 'uid-' + type(error).__name__
            messages = [{'role': 'user', 'content': 'question'},
                        {'role': 'assistant', 'content': 'AGENT TERMINAL', 'message_uid': 'u-1'}]
            host, db, consumer, seen, _ = self._wire(run_ref, {})
            sid = self.sids[run_ref]
            self._flush(db, sid, messages)

            def raiser(session_id, message_uid, _e=error):
                raise _e

            db.message_id_by_uid = raiser
            bound = GatewayTurnPersistenceMixin._hmwa_persist_turn_transcript.__get__(host)
            receipt = asyncio.run(bound(
                event=SimpleNamespace(message_id=None, internal=False, reply_expected=True),
                source=SimpleNamespace(platform=None, user_id='1', chat_id='', chat_type=''),
                session_entry=SimpleNamespace(session_id=sid, session_key='chain-key'),
                session_key='chain-key',
                agent_result={'history_offset': 0, 'last_prompt_tokens': 0, 'agent_persisted': True},
                agent_messages=messages,
                prepared=SimpleNamespace(history=[], persist_user_display_kind=None,
                                         message_text='question'),
                response='AGENT TERMINAL', agent_failed_early=False,
                hidden_reasoning_incomplete=False, is_context_overflow_failure=False,
                run_ref=run_ref, hook_ctx={'execution_ref': run_ref}))
            self.assertIsNone(receipt, 'unprovable terminal must not produce a receipt')
            self.assertEqual(seen, [])
            self.assertIsNone(consumer.payload_of(run_ref))


if __name__ == '__main__':
    unittest.main()
