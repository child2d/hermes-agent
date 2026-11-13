"""Host-only persisted completion consumer; no task execution or agent-callable API.

``agent:end`` is an intent signal, not a success signal. The integration emits
``agent:delivery-ready`` after transcript persistence and failure classification, and that event
must carry the **persisted canonical message id** — the display text can hold footers, reasoning or
a failure notice that is never written to ``messages.content``, so it is not an identity.

Recovery is deliberately conservative: without a durable association between a run and a canonical
terminal row the run stays ``pending_terminal_association``. An assistant row that still carries
``tool_calls`` is a mid-turn step and is never published as an outcome.

Only the explicitly pinned session may be exported. No binding means no network.
"""

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
from contextlib import closing
from pathlib import Path

from .delivery_outbox import SUMMARY_HINT, SUMMARY_LIMIT, DeliveryOutbox, clip_utf16
from .runtime_bridge import ENDPOINT

_APP_ID = 0x42434D50
# Only the persistence call that actually appended the row can name this run's terminal.
APPEND_RECEIPT_SOURCE = 'append_return'
# The agent's own insert path is equally exact: its uid is minted by the writer and stored with the row.
AGENT_PERSIST_RECEIPT_SOURCE = 'agent_persist_uid'
RECEIPT_SOURCES = (APPEND_RECEIPT_SOURCE, AGENT_PERSIST_RECEIPT_SOURCE)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class CompletionConsumer:
    def __init__(self, state_path, intent_path, session_id, outbox, transport=None, transport_factory=None):
        self.state_path = Path(state_path).resolve()
        self.intent_path = Path(intent_path)
        self.session_id, self.outbox, self.transport = session_id, outbox, transport
        self.transport_factory = transport_factory
        self.outbox_path = outbox.db.execute('PRAGMA database_list').fetchone()[2]
        self.intent_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.intent_path)) as db, db:
            identity = db.execute('PRAGMA application_id').fetchone()[0]
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if identity == 0 and not tables:
                db.execute('CREATE TABLE intents(execution_ref TEXT PRIMARY KEY, floor INTEGER NOT NULL, '
                           'payload TEXT, receipt TEXT, predecessor TEXT, seq INTEGER, terminal_id INTEGER)')
                db.execute(f'PRAGMA application_id={_APP_ID}')
            elif identity != _APP_ID or tables != {'intents'}:
                raise ValueError('Unrecognized completion store; do not reset')
            else:
                columns = {r[1] for r in db.execute('PRAGMA table_info(intents)')}
                for column in ('receipt', 'predecessor', 'seq', 'terminal_id'):
                    if column not in columns:
                        # Additive: a store written by an earlier build keeps working. A run admitted
                        # before ``terminal_id`` existed simply has no association and will block.
                        kind = 'INTEGER' if column == 'terminal_id' else 'TEXT'
                        db.execute(f'ALTER TABLE intents ADD COLUMN {column} {kind}')
        os.chmod(self.intent_path, 0o600)

    # -- canonical reads -------------------------------------------------------
    def _connect(self):
        return closing(sqlite3.connect(self.state_path.as_uri() + '?mode=ro', uri=True))

    def _latest(self):
        """The newest canonical row, with the fields that decide "is this a terminal?"."""
        with self._connect() as db:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT id,session_id,role,content,display_kind,tool_calls,finish_reason '
                             'FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1',
                             (self.session_id,)).fetchone()
            return dict(row) if row else None

    def _by_id(self, message_id):
        with self._connect() as db:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT id,session_id,role,content,display_kind,tool_calls,finish_reason '
                             'FROM messages WHERE id=?', (int(message_id),)).fetchone()
            return dict(row) if row else None

    @staticmethod
    def _is_terminal_row(row):
        """Assistant without pending tool calls. A tool-call row is a mid-turn step, not an outcome."""
        return bool(row) and row.get('role') == 'assistant' and not row.get('tool_calls')

    def _later_admissions(self, execution_ref, floor):
        """Runs whose terminal cannot be safely attributed to ``execution_ref``.

        Message ids are NOT run order: two admissions can share the same floor (A admitted and
        interrupted before any new message, then B admitted). An admission sequence is the only
        reliable order here, and any other admission at the same floor is already ambiguous.
        """
        with closing(sqlite3.connect(self.intent_path)) as db:
            mine = db.execute('SELECT seq FROM intents WHERE execution_ref=?', (execution_ref,)).fetchone()
            my_seq = mine[0] if mine else None
            rows = db.execute('SELECT execution_ref, floor, seq FROM intents WHERE execution_ref != ?',
                              (execution_ref,)).fetchall()
        blocked = []
        for ref, other_floor, other_seq in rows:
            if other_floor == floor or other_seq is None or my_seq is None or other_seq > my_seq:
                blocked.append(ref)
        return blocked

    # -- event handling --------------------------------------------------------
    def handle(self, event, context):
        if not self.session_id or context.get('session_id') != self.session_id:
            return None
        if event not in ('agent:start', 'agent:end', 'agent:delivery-ready'):
            return None
        execution_ref = context.get('execution_ref')
        if not isinstance(execution_ref, str) or not execution_ref:
            return {'status': 'blocked_runtime_reference'}
        with closing(sqlite3.connect(self.intent_path)) as db, db:
            if event == 'agent:start':
                latest = self._latest()
                predecessor = context.get('expected_current_delivery_id')
                if predecessor is not None and not isinstance(predecessor, str):
                    raise ValueError('Predecessor must be a string at admission')
                next_seq = (db.execute('SELECT COALESCE(MAX(seq), 0) + 1 FROM intents').fetchone() or [1])[0]
                cursor = db.execute('INSERT OR IGNORE INTO intents(execution_ref,floor,predecessor,seq) '
                                    'VALUES(?,?,?,?)',
                                    (execution_ref, latest['id'] if latest else 0, predecessor, next_seq))
                row = db.execute('SELECT seq, predecessor FROM intents WHERE execution_ref=?',
                                 (execution_ref,)).fetchone()
                if cursor.rowcount != 1:
                    # The run was already admitted: the caller must not execute it a second time.
                    return {'status': 'duplicate', 'predecessorCaptured': row[1] is not None,
                            'admissionSeq': row[0] if row else None}
                return {'status': 'started', 'predecessorCaptured': predecessor is not None,
                        'admissionSeq': row[0] if row else None}
            row = db.execute('SELECT floor,payload,receipt,terminal_id FROM intents WHERE execution_ref=?',
                             (execution_ref,)).fetchone()
            if row is None:
                raise ValueError('Run admission intent missing')
            if event == 'agent:end':
                return {'status': 'awaiting_persisted_terminal'}
            canonical_id = context.get('canonical_message_id')
            if canonical_id is None:
                return {'status': 'blocked_terminal_identity',
                        'reason': 'delivery event must carry the persisted canonical message id'}
            # A row id is only trustworthy when the *writing* path says it produced this run's
            # terminal. "Newest assistant without tool_calls" is not proof: an intermediate text
            # message looks identical. Without that binding the run stays pending.
            if context.get('terminal_source') not in RECEIPT_SOURCES:
                return {'status': 'blocked_terminal_receipt',
                        'reason': 'delivery event lacks a persistence receipt'}
            if context.get('terminal_run') != execution_ref:
                return {'status': 'blocked_terminal_receipt',
                        'reason': 'persistence receipt belongs to another run'}
            terminal = self._by_id(canonical_id)
            if not self._is_terminal_row(terminal):
                raise ValueError('Delivered message id is not a terminal assistant row')
            if terminal['session_id'] != self.session_id:
                return {'status': 'blocked_foreign_session'}
            if row[1]:
                saved = json.loads(row[1])
                if saved['terminal_message_id'] != terminal['id'] or saved['outcome'] != context.get('outcome'):
                    if saved.get('recovered') and saved['terminal_message_id'] == terminal['id']:
                        if row[2]:
                            return json.loads(row[2])
                        return {'status': 'ready_to_writeback', 'execution_ref': execution_ref, 'recovered': True}
                    raise ValueError('Completed execution content conflict')
                if row[2]:
                    return json.loads(row[2])
            else:
                if terminal['id'] <= row[0]:
                    raise ValueError('Terminal is not newer than this run admission')
                if context.get('outcome') not in ('completed', 'failed'):
                    raise ValueError('Runtime terminal outcome required')
                if 'failed' in (terminal.get('display_kind') or '') and context['outcome'] != 'failed':
                    raise ValueError('Failure cannot become successful completion')
                summary = terminal['content']
                if not isinstance(summary, str) or not summary.strip() or len(summary.encode()) > 262144:
                    raise ValueError('Bounded nonempty persisted output required')
                payload = {'execution_ref': execution_ref, 'session_id': self.session_id,
                           'terminal_message_id': terminal['id'], 'summary': summary,
                           'outcome': context['outcome'],
                           'output_sha256': hashlib.sha256(summary.encode()).hexdigest()}
                db.execute('UPDATE intents SET payload=?, terminal_id=? WHERE execution_ref=?',
                           (_json(payload), terminal['id'], execution_ref))
        enabled = self.transport_factory is not None or (self.transport is not None and self.transport.issuer.binding is not None)
        return {'status': 'ready_to_writeback' if enabled else 'blocked_binding', 'execution_ref': execution_ref}

    # -- writeback -------------------------------------------------------------
    def resume(self, execution_ref):
        with closing(sqlite3.connect(self.intent_path)) as db:
            row = db.execute('SELECT payload,receipt,predecessor FROM intents WHERE execution_ref=?',
                             (execution_ref,)).fetchone()
        if row is None or row[0] is None:
            return {'status': 'awaiting_persisted_terminal'}
        if row[1]:
            return json.loads(row[1])
        if row[2] is None:
            # No frozen predecessor: admitted before the contract existed (or without one).
            # Inventing "" here would let it overwrite an unknown current delivery.
            return {'status': 'blocked_predecessor',
                    'reason': 'predecessor must be captured when the run is admitted'}
        transport = self.transport_factory(execution_ref) if self.transport_factory else self.transport
        if transport is None or transport.issuer.binding is None:
            return {'status': 'blocked_binding'}
        binding = transport.issuer.require_binding()
        if binding.execution_ref != execution_ref:
            raise ValueError('Transport bound to another execution')
        payload = json.loads(row[0])
        summary = clip_utf16(payload['summary'])
        unfinished = ['运行失败；需核查已发生的作用及剩余工作，不自动重跑任务'] if payload['outcome'] == 'failed' else None
        if payload.get('recovered') and unfinished is None:
            unfinished = ['完成事件丢失，已按 canonical 终态补发交付；未完成项需人工核对，不重跑任务']
        version = 'run-' + hashlib.sha256(execution_ref.encode()).hexdigest()[:32]
        key = self.outbox.enqueue(endpoint=ENDPOINT, issue_id=binding.issue_id, execution_ref=execution_ref,
                                  version=version, summary=summary, unfinished=unfinished,
                                  outcome=payload['outcome'], expected_current_delivery_id=row[2],
                                  artifacts=[{'name': 'runtime-receipt.json',
                                              'content': _json({k: v for k, v in payload.items() if k != 'summary'})},
                                             {'name': 'runtime-output.txt', 'content': payload['summary']}])
        receipt = self.outbox.resume(key, transport)
        result = {'status': 'submitted', 'execution_ref': execution_ref, 'outbox_key': key, 'delivery': receipt}
        with closing(sqlite3.connect(self.intent_path)) as db, db:
            db.execute('UPDATE intents SET receipt=? WHERE execution_ref=?', (_json(result), execution_ref))
        return result

    def payload_of(self, execution_ref):
        """Read-only accessor for a run's recorded payload (host/debug use; never a write path)."""
        with closing(sqlite3.connect(self.intent_path)) as db:
            row = db.execute('SELECT payload FROM intents WHERE execution_ref=?',
                             (execution_ref,)).fetchone()
        return row[0] if row and row[0] else None

    def pending_runs(self):
        with closing(sqlite3.connect(self.intent_path)) as db:
            return [r[0] for r in db.execute('SELECT execution_ref FROM intents '
                                             'WHERE payload IS NOT NULL AND receipt IS NULL')]

    def unfinished_runs(self):
        """Every admitted run without a delivery receipt, including runs whose ready event vanished."""
        with closing(sqlite3.connect(self.intent_path)) as db:
            return [r[0] for r in db.execute('SELECT execution_ref FROM intents WHERE receipt IS NULL')]

    # -- recovery --------------------------------------------------------------
    def associate_terminal(self, execution_ref, message_id, *, source=None, run=None):
        """Record a durable run↔terminal association a human verified; this is not automatic.

        The caller must also state *where the binding came from*: only the persistence call that
        appended this run's terminal (``source='append_return'``, ``run=execution_ref``) counts.
        A row that merely looks terminal (assistant, no pending tool calls) is not enough, and an
        intermediate text message looks exactly the same.
        """
        if source not in RECEIPT_SOURCES or run != execution_ref:
            raise ValueError('Only the persistence receipt of this run can name its terminal')
        with closing(sqlite3.connect(self.intent_path)) as db:
            row = db.execute('SELECT floor,payload,receipt FROM intents WHERE execution_ref=?',
                             (execution_ref,)).fetchone()
        if row is None:
            raise ValueError('Run admission intent missing')
        terminal = self._by_id(message_id)
        if not self._is_terminal_row(terminal):
            raise ValueError('Only a terminal assistant row can be associated with a run')
        if terminal['session_id'] != self.session_id:
            raise ValueError('Terminal belongs to another session')
        if terminal['id'] <= row[0]:
            raise ValueError('Terminal is not newer than this run admission')
        with closing(sqlite3.connect(self.intent_path)) as db, db:
            db.execute('UPDATE intents SET terminal_id=? WHERE execution_ref=?', (terminal['id'], execution_ref))
        return {'status': 'associated', 'execution_ref': execution_ref, 'terminal_message_id': terminal['id']}

    def recover_from_canonical(self, execution_ref):
        """Host-only repair for a lost completion event.

        Re-derives a delivery from the canonical transcript instead of re-running the task, but only
        when the run has a durable association with a terminal row. Without one the run stays
        ``pending_terminal_association`` — the newest assistant row cannot be attributed to this run
        by itself, and a tool-call row is not an outcome at all.
        """
        with closing(sqlite3.connect(self.intent_path)) as db:
            row = db.execute('SELECT floor,payload,receipt,terminal_id FROM intents WHERE execution_ref=?',
                             (execution_ref,)).fetchone()
        if row is None:
            raise ValueError('Run admission intent missing')
        if row[2]:
            return {'status': 'already_delivered', 'execution_ref': execution_ref}
        if row[1]:
            return {'status': 'awaiting_writeback', 'execution_ref': execution_ref}
        if row[3] is None:
            return {'status': 'pending_terminal_association', 'execution_ref': execution_ref,
                    'reason': 'no durable association between this run and a canonical terminal row'}
        terminal = self._by_id(row[3])
        if not self._is_terminal_row(terminal):
            return {'status': 'pending_terminal_association', 'execution_ref': execution_ref,
                    'reason': 'associated row is not a terminal assistant row'}
        later = self._later_admissions(execution_ref, row[0])
        if later:
            return {'status': 'ambiguous_terminal', 'execution_ref': execution_ref, 'blocked_by': later,
                    'reason': 'later runs share this session; the latest output cannot be attributed to this run'}
        if any(marker in (terminal.get('display_kind') or '') for marker in ('failed', 'error')):
            outcome = 'failed'
        else:
            outcome = 'unknown'
        summary = terminal['content']
        if not isinstance(summary, str) or not summary.strip():
            return {'status': 'no_terminal', 'execution_ref': execution_ref}
        if len(summary.encode()) > 262144:
            return {'status': 'terminal_too_large', 'execution_ref': execution_ref}
        payload = {'execution_ref': execution_ref, 'session_id': self.session_id,
                   'terminal_message_id': terminal['id'], 'summary': summary, 'outcome': outcome,
                   'recovered': True,
                   'recovery_reason': 'delivery-ready event was not received; derived from an associated canonical terminal',
                   'output_sha256': hashlib.sha256(summary.encode()).hexdigest()}
        with closing(sqlite3.connect(self.intent_path)) as db, db:
            db.execute('UPDATE intents SET payload=? WHERE execution_ref=?', (_json(payload), execution_ref))
        return {'status': 'recovered_terminal', 'execution_ref': execution_ref, 'outcome': outcome,
                'requires_reconciliation': True}


_consumers = {}
_tasks = {}


def configure_consumer(consumer):
    """Called by the trusted host bootstrap, never exposed as an agent tool.

    Per-profile binding matters in a multiplexed gateway; no process-global
    fallback may export another profile's sessions.
    """
    from hermes_cli.config import get_hermes_home
    home = str(get_hermes_home().resolve())
    if consumer is None:
        _consumers.pop(home, None)
    else:
        _consumers[home] = consumer


def _resume_in_worker(consumer, execution_ref):
    # SQLite connections are thread-affine. Open an independent connection in
    # the worker instead of sharing the hook's connection or disabling checks.
    outbox = DeliveryOutbox(consumer.outbox_path)
    try:
        worker = CompletionConsumer(consumer.state_path, consumer.intent_path, consumer.session_id,
                                    outbox, consumer.transport, consumer.transport_factory)
        return worker.resume(execution_ref)
    finally:
        outbox.close()


async def _writeback(consumer, execution_ref):
    for attempt in range(3):
        try:
            return await asyncio.to_thread(_resume_in_worker, consumer, execution_ref)
        except ValueError:
            logging.getLogger(__name__).warning('Runtime writeback scope rejected; pending record retained')
            return
        except Exception:
            if attempt == 2:
                logging.getLogger(__name__).warning('Runtime writeback unconfirmed; pending record retained')
                return
            await asyncio.sleep(2 ** attempt)


async def dispatch(event, context):
    from hermes_cli.config import get_hermes_home
    home = str(get_hermes_home().resolve())
    consumer = _consumers.get(home)
    if consumer is None:
        return {'status': 'disabled'}
    if event == 'gateway:startup':
        # Sweep every admitted run without a receipt. A lost delivery-ready event is only repaired
        # when the run has a durable terminal association; otherwise it stays for human triage.
        runs = await asyncio.to_thread(consumer.unfinished_runs)
        for execution_ref in runs:
            recovery = await asyncio.to_thread(consumer.recover_from_canonical, execution_ref)
            if recovery.get('status') not in ('recovered_terminal', 'awaiting_writeback'):
                logging.getLogger(__name__).warning('Run %s still needs reconciliation: %s',
                                                   execution_ref, recovery.get('status'))
        result = {'status': 'recovery_scheduled', 'admitted': len(runs)}
    else:
        result = await asyncio.to_thread(consumer.handle, event, context)
        runs = [result['execution_ref']] if result and result.get('status') == 'ready_to_writeback' else []
    for execution_ref in runs:
        key = (home, execution_ref)
        if key not in _tasks or _tasks[key].done():
            _tasks[key] = asyncio.create_task(_writeback(consumer, execution_ref))
    return result
