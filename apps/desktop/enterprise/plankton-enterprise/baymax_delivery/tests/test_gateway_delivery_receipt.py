"""Core delivery notification must be inert unless a host wires a verified receipt.

Regression for the round-2 finding: the previous head called ``async_session_store.get_messages``
on every turn, which raised ``AttributeError`` on the real Gateway facade (``AsyncSessionStore`` ->
``SessionStore`` has no such method) and turned a finished turn into an error reply. Here the real
function is exercised, the real store classes are checked for the interface that must not be used,
and a strict sentinel proves the disabled path performs no store I/O at all.
"""

import asyncio
import sys
import unittest

import _path_setup

sys.path.insert(0, str(_path_setup.REPO_ROOT))

from gateway.delivery_notify import notify_delivery_ready
from gateway.session import AsyncSessionStore, SessionStore


class _StrictStore:
    """Any attribute access fails: proves the notification path performs no store I/O."""

    def __getattr__(self, name):
        raise AssertionError(f'the delivery notification must not touch the store (asked for {name})')


class _Recorder:
    def __init__(self):
        self.events = []

    async def emit(self, event, context=None):
        self.events.append((event, context))


class _SessionEntry:
    session_id = 's1'


def _notify(provider, hooks=None):
    hooks = hooks or _Recorder()
    emitted = asyncio.run(notify_delivery_ready(
        hooks=hooks, provider=provider, session_entry=_SessionEntry(), agent_result={},
        response='answer', outcome='completed', hook_ctx={'execution_ref': 'run-1'}))
    return emitted, hooks


class CoreDeliveryInertness(unittest.TestCase):
    def test_the_real_store_interface_has_no_get_messages(self):
        self.assertFalse(hasattr(SessionStore, 'get_messages'))
        self.assertFalse(hasattr(AsyncSessionStore, 'get_messages'))

    def test_no_provider_means_no_store_access_and_no_event(self):
        store = _StrictStore()  # touching it would raise
        emitted, hooks = _notify(None)
        self.assertFalse(emitted)
        self.assertEqual(hooks.events, [])
        del store

    def test_a_provider_that_cannot_name_a_terminal_emits_nothing(self):
        emitted, hooks = _notify(lambda **_: None)
        self.assertFalse(emitted)
        self.assertEqual(hooks.events, [])

    def test_a_provider_with_a_partial_receipt_is_refused(self):
        emitted, hooks = _notify(lambda **_: {'message_id': 3})  # no session
        self.assertFalse(emitted)
        self.assertEqual(hooks.events, [])

    def test_a_failing_provider_never_breaks_the_turn(self):
        def broken(**_):
            raise RuntimeError('provider exploded')

        emitted, hooks = _notify(broken)  # must not raise: the reply path continues
        self.assertFalse(emitted)
        self.assertEqual(hooks.events, [])

    def test_a_verified_receipt_is_forwarded_verbatim(self):
        receipt = {'message_id': 7, 'session_id': 's1', 'run': 'run-1', 'source': 'append_return'}
        emitted, hooks = _notify(lambda **_: receipt)
        self.assertTrue(emitted)
        event, context = hooks.events[0]
        self.assertEqual(event, 'agent:delivery-ready')
        self.assertEqual(context['canonical_message_id'], 7)
        self.assertEqual(context['terminal_run'], 'run-1')
        self.assertEqual(context['terminal_source'], 'append_return')


class RunTurnPersistFailure(unittest.TestCase):
    """A failed final persist must leave the run pending, not deliver or invent an id."""

    def test_failed_terminal_write_keeps_the_run_pending(self):
        import sqlite3
        import tempfile
        from pathlib import Path

        from baymax_delivery.completion_hook import CompletionConsumer
        from baymax_delivery.delivery_outbox import DeliveryOutbox
        from baymax_delivery.run_turn_delivery import run_turn
        from hermes_state import SessionDB

        class _Model:
            def complete(self, prompt):
                return 'answer', {}

        class _Transport:
            def read_state(self, *, endpoint, issue_id):
                return {'expectedCurrentDeliveryId': ''}

        class _BrokenStore:
            def append_message(self, *args, **kwargs):
                raise RuntimeError('disk full')

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = SessionDB(db_path=root / 'state.db')
            store.create_session('s1', 'test')
            outbox = DeliveryOutbox(root / 'outbox.sqlite3')
            consumer = CompletionConsumer(root / 'state.db', root / 'intents.sqlite', 's1', outbox)
            try:
                with self.assertRaises(RuntimeError):
                    run_turn(transport=_Transport(), consumer=consumer, model=_Model(),
                             store=_BrokenStore(), session_id='s1', execution_ref='run-fail',
                             issue_id='5001', prompt='x', artifacts_dir=root / 'artifacts',
                             admission_path=root / 'admissions.sqlite3')
                self.assertIsNone(consumer.payload_of('run-fail'))
                with sqlite3.connect(root / 'admissions.sqlite3') as db:
                    self.assertEqual(db.execute('SELECT state FROM admissions').fetchone()[0],
                                     'abandoned')
            finally:
                outbox.close()
                try:
                    store.close()
                except Exception:
                    pass


if __name__ == '__main__':
    unittest.main()
