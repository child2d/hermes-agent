"""Real-facade receipt chain: persistence return value -> delivery event identity.

Uses the repository's real ``SessionStore`` (over a real SQLite state DB) and its
``AsyncSessionStore`` facade — not a stand-in with a convenient method. The point of these tests is
that the terminal identity comes from what the write call returned:

* a synchronous write returns the row id (the receipt),
* a queued/deferred write returns ``None`` (so the run stays pending),
* an agent-persisted row is adopted by the uid the insert path stamped (exact), not by "newest row".
"""

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

import _path_setup

sys.path.insert(0, str(_path_setup.REPO_ROOT))

from gateway.config import GatewayConfig
from gateway.delivery_notify import notify_delivery_ready
from gateway.session import AsyncSessionStore, SessionStore


class _Recorder:
    def __init__(self):
        self.events = []

    async def emit(self, event, context=None):
        self.events.append((event, context))


class ReceiptChain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='baymax-receipt-')
        self.root = Path(self.tmp.name)
        self.store = SessionStore(self.root / 'sessions', GatewayConfig())
        self.session_id = 'receipt-session'
        self.db = self.store._db_for_session_id(self.session_id)
        self.db.ensure_session(self.session_id, 'test')

    def tearDown(self):
        try:
            self.store.close()
        except Exception:
            pass
        self.tmp.cleanup()

    def test_a_synchronous_append_returns_the_row_id_and_the_row_exists(self):
        row_id = self.store.append_to_transcript(
            self.session_id, {'role': 'assistant', 'content': 'terminal body'})
        self.assertIsInstance(row_id, int)
        rows = [r for r in self.db.get_messages(self.session_id) if r['id'] == row_id]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['content'], 'terminal body')

    def test_the_async_facade_propagates_the_same_receipt(self):
        facade = AsyncSessionStore(self.store)
        row_id = asyncio.run(facade.append_to_transcript(
            self.session_id, {'role': 'assistant', 'content': 'via facade'}))
        self.assertIsInstance(row_id, int)
        self.assertEqual(self.db.get_messages(self.session_id)[-1]['id'], row_id)

    def test_a_queued_append_returns_none_instead_of_a_receipt(self):
        # No sessions row -> the write is queued for retry, so there is no persisted row to name.
        row_id = self.store.append_to_transcript(
            'unknown-session', {'role': 'assistant', 'content': 'queued'})
        self.assertIsNone(row_id)

    def test_agent_persisted_row_is_adopted_by_uid_not_by_position(self):
        uid_row = self.db.append_message(self.session_id, 'assistant', 'agent wrote this',
                                         display_kind='final', message_uid=None)
        uid = self.db.get_messages(self.session_id)[-1]['message_uid']
        self.assertIsNotNone(uid)
        self.assertEqual(self.db.message_id_by_uid(self.session_id, uid), uid_row)
        # A later unrelated row must not change the answer: the uid is the identity.
        self.db.append_message(self.session_id, 'assistant', 'later noise')
        self.assertEqual(self.db.message_id_by_uid(self.session_id, uid), uid_row)
        self.assertIsNone(self.db.message_id_by_uid(self.session_id, 'not-a-uid'))

    def test_notify_emits_only_with_a_receipt_and_binds_the_run(self):
        hooks = _Recorder()
        emitted = asyncio.run(notify_delivery_ready(
            hooks=hooks, provider=None, session_entry=type('S', (), {'session_id': self.session_id})(),
            agent_result={}, response='x', outcome='completed', run_ref='run-1'))
        self.assertFalse(emitted)
        self.assertEqual(hooks.events, [])

        receipt = {'message_id': 42, 'session_id': self.session_id, 'source': 'append_return'}
        emitted = asyncio.run(notify_delivery_ready(
            hooks=hooks, provider=lambda **_: receipt,
            session_entry=type('S', (), {'session_id': self.session_id})(),
            agent_result={}, response='x', outcome='completed', run_ref='run-1'))
        self.assertTrue(emitted)
        event, context = hooks.events[0]
        self.assertEqual(event, 'agent:delivery-ready')
        self.assertEqual(context['canonical_message_id'], 42)
        self.assertEqual(context['terminal_run'], 'run-1')
        self.assertEqual(context['terminal_source'], 'append_return')


if __name__ == '__main__':
    unittest.main()
