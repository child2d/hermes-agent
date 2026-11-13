"""Durable sandbox writeback core for a trusted runtime host, not an agent tool.

The transport owns authentication and must provide server-side idempotency for
both registration and submission. This module never executes business work.
"""
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone, UTC
from pathlib import Path

from .delivery_errors import DeliveryCancelled, DeliveryRevoked

_ENDPOINT = 'https://baymax-bff-sandbox.shaoke.com/graphql'
_APPLICATION_ID = 0x42444C56
SUMMARY_LIMIT = 8000
SUMMARY_HINT = '\n完整运行终态见证据。'


def utf16_len(value):
    """Length in UTF-16 code units, i.e. what JavaScript's String.length counts."""
    return len(value.encode('utf-16-le')) // 2


def clip_utf16(value, limit=SUMMARY_LIMIT, hint=SUMMARY_HINT):
    """Clip to the backend's UTF-16 budget, always leaving room for the truncation hint."""
    if utf16_len(value) <= limit:
        return value
    usable_hint = hint if utf16_len(hint) <= limit else ''
    budget = limit - utf16_len(usable_hint)
    kept, used = [], 0
    for char in value:
        units = 2 if ord(char) > 0xFFFF else 1
        if used + units > budget:
            break
        kept.append(char)
        used += units
    return ''.join(kept) + usable_hint


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _timestamp():
    return datetime.now(UTC).isoformat()


class DeliveryOutbox:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=5)
        identity = self.db.execute('PRAGMA application_id').fetchone()[0]
        tables = {r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if identity == 0 and not tables:
            with self.db:
                self.db.execute('CREATE TABLE queue (key TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT, cancelled_at TEXT, attempted_at TEXT)')
                self.db.execute('CREATE TABLE uploads (queue_key TEXT NOT NULL, slot INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(queue_key,slot))')
                self.db.execute(f'PRAGMA application_id={_APPLICATION_ID}')
        elif identity != _APPLICATION_ID or tables != {'queue', 'uploads'}:
            self.db.close()
            raise ValueError('Unrecognized or incomplete outbox; do not reset')
        columns = {row[1] for row in self.db.execute('PRAGMA table_info(queue)')}
        for column in ('cancelled_at', 'attempted_at'):
            if column not in columns:
                # Additive: an outbox written by an earlier build keeps working.
                with self.db:
                    self.db.execute(f'ALTER TABLE queue ADD COLUMN {column} TEXT')
        os.chmod(path, 0o600)

    def close(self):
        self.db.close()

    def enqueue(self, *, endpoint, issue_id, execution_ref, version, summary, unfinished, artifacts, outcome=None,
                expected_current_delivery_id=None):
        if endpoint != _ENDPOINT or not isinstance(issue_id, str) or not issue_id.isascii() or not issue_id.isdigit() or issue_id.startswith('0'):
            raise ValueError('Confirmed sandbox environment and issue primary key required')
        if not all(isinstance(v, str) and v.strip() for v in (execution_ref, version, summary)) or not artifacts:
            raise ValueError('Runtime reference, version, summary and evidence required')
        summary = clip_utf16(summary)
        if expected_current_delivery_id is None or not isinstance(expected_current_delivery_id, str):
            raise ValueError('Predecessor must be fixed at prepare time: "" means no current delivery')
        if unfinished is not None and not isinstance(unfinished, list):
            raise ValueError('Unfinished items must be recorded as a list or unknown')
        if outcome is not None and outcome not in ('completed', 'failed', 'unknown', 'unsupported'):
            raise ValueError('Outcome must be completed, failed, unknown or unsupported')
        for item in artifacts:
            if not item.get('name') or not isinstance(item.get('content'), str):
                raise ValueError('Materialized evidence required')
        document = dict(endpoint=endpoint, issue_id=issue_id, execution_ref=execution_ref, version=version,
                        summary=summary, unfinished=unfinished, artifacts=artifacts, outcome=outcome,
                        expected_current_delivery_id=expected_current_delivery_id)
        key = hashlib.sha256(_json([endpoint, issue_id, execution_ref, version]).encode()).hexdigest()
        serialized = _json(document)
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO queue(key,payload,receipt) VALUES (?,?,NULL)', (key, serialized))
            if self.db.execute('SELECT payload FROM queue WHERE key=?', (key,)).fetchone()[0] != serialized:
                raise ValueError('Existing execution version has different content')
        return key

    @staticmethod
    def _canonical_submit(payload, key, evidence_ids):
        """The exact client payload frozen at prepare time. Server-added keys are never compared."""
        return {
            'issueId': payload['issue_id'],
            'requestKey': key,
            'executionRef': payload['execution_ref'],
            'version': payload['version'],
            'summary': payload['summary'],
            'unfinished': payload.get('unfinished'),
            'evidenceIds': list(evidence_ids),
            'outcome': payload.get('outcome'),
            'expectedCurrentDeliveryId': payload.get('expected_current_delivery_id'),
        }

    def _read_receipt(self, transport, endpoint, issue_id, operation, request_key, expected=None):
        reader = getattr(transport, 'read_receipt', None)
        if reader is None:
            return None
        return reader(endpoint=endpoint, issue_id=issue_id, operation=operation, request_key=request_key,
                      expected=expected)

    def reconcile(self, key, transport):
        """Resolve an unknown write outcome from server truth without performing business work.

        Returns the stored/confirmed receipt, or None when the server has no receipt for
        this key (in which case the same key may be sent again). It never submits work.
        """
        row = self.db.execute('SELECT payload,receipt,cancelled_at FROM queue WHERE key=?', (key,)).fetchone()
        if row is None:
            raise KeyError(key)
        if row[2]:
            raise DeliveryCancelled('This execution was cancelled; do not resubmit it')
        payload = json.loads(row[0])
        if row[1]:
            return json.loads(row[1])
        evidence = []
        for slot, _artifact in enumerate(payload['artifacts']):
            saved = self.db.execute('SELECT receipt FROM uploads WHERE queue_key=? AND slot=?', (key, slot)).fetchone()
            if saved:
                evidence.append(json.loads(saved[0])['id'])
                continue
            found = self._read_receipt(transport, payload['endpoint'], payload['issue_id'], 'evidence',
                                      f'{key}:evidence:{slot}',
                                      expected={'sha256': hashlib.sha256(payload['artifacts'][slot]['content'].encode()).hexdigest(),
                                                'name': payload['artifacts'][slot]['name']})
            if not isinstance(found, dict) or not found.get('id'):
                return None
            with self.db:
                self.db.execute('INSERT OR IGNORE INTO uploads VALUES (?,?,?)', (key, slot, _json(found)))
            evidence.append(found['id'])
        found = self._read_receipt(transport, payload['endpoint'], payload['issue_id'], 'submit', key,
                                   expected=self._canonical_submit(payload, key, evidence))
        if not isinstance(found, dict) or not found.get('id'):
            return None
        with self.db:
            self.db.execute('UPDATE queue SET receipt=? WHERE key=?', (_json(found), key))
        return found

    def resume(self, key, transport, reconcile_unknown=True):
        row = self.db.execute('SELECT payload,receipt,cancelled_at,attempted_at FROM queue WHERE key=?', (key,)).fetchone()
        if row is None:
            raise KeyError(key)
        if row[2]:
            # A cancelled execution is never retried, even after a restart.
            raise DeliveryCancelled('This execution was cancelled; do not resubmit it')
        payload = json.loads(row[0])
        if row[1]:
            return json.loads(row[1])
        if row[3] and reconcile_unknown:
            # A previous attempt's outcome was never observed: check server truth BEFORE writing again.
            # If the query itself is unavailable, stay pending instead of sending another write.
            confirmed = self.reconcile(key, transport)
            if confirmed:
                return confirmed
        try:
            self._mark_attempt(key)
            return self._write(key, payload, transport)
        except DeliveryCancelled:
            # The reviewed execution was cancelled: record it locally and stop. This does not
            # mean the executor stopped running; side effects may already exist.
            with self.db:
                self.db.execute('UPDATE queue SET cancelled_at=COALESCE(cancelled_at,?) WHERE key=?', (_timestamp(), key))
            raise
        except DeliveryRevoked:
            raise
        except Exception:
            if not reconcile_unknown:
                raise
            # An unobserved outcome is resolved from server truth, never by guessing.
            try:
                resolved = self.reconcile(key, transport)
            except DeliveryCancelled:
                raise
            except Exception:
                resolved = None  # Unreadable receipt: keep the outbox pending and surface the original failure.
            if resolved:
                return resolved
            raise

    def _mark_attempt(self, key):
        with self.db:
            self.db.execute('UPDATE queue SET attempted_at=COALESCE(attempted_at,?) WHERE key=?', (_timestamp(), key))

    def is_cancelled(self, key):
        row = self.db.execute('SELECT cancelled_at FROM queue WHERE key=?', (key,)).fetchone()
        if row is None:
            raise KeyError(key)
        return bool(row[0])

    def is_attempt_unconfirmed(self, key):
        row = self.db.execute('SELECT receipt,attempted_at FROM queue WHERE key=?', (key,)).fetchone()
        if row is None:
            raise KeyError(key)
        return bool(row[1]) and not bool(row[0])

    def _write(self, key, payload, transport):
        evidence = []
        for slot, artifact in enumerate(payload['artifacts']):
            saved = self.db.execute('SELECT receipt FROM uploads WHERE queue_key=? AND slot=?', (key, slot)).fetchone()
            if saved:
                receipt = json.loads(saved[0])
            else:
                receipt = transport.register_evidence(endpoint=payload['endpoint'], issue_id=payload['issue_id'],
                    name=artifact['name'], content=artifact['content'], request_key=f'{key}:evidence:{slot}')
                if not isinstance(receipt, dict) or not receipt.get('id'):
                    raise ValueError('Evidence acknowledgement missing; reconcile before continuing')
                with self.db:
                    self.db.execute('INSERT OR IGNORE INTO uploads VALUES (?,?,?)', (key, slot, _json(receipt)))
                    persisted = json.loads(self.db.execute('SELECT receipt FROM uploads WHERE queue_key=? AND slot=?', (key, slot)).fetchone()[0])
                    if persisted['id'] != receipt['id']:
                        raise ValueError('Evidence receipt conflict')
            evidence.append(receipt['id'])
        receipt = transport.submit_delivery(endpoint=payload['endpoint'], issue_id=payload['issue_id'],
            execution_ref=payload['execution_ref'], version=payload['version'], summary=payload['summary'],
            unfinished=payload['unfinished'], evidence_ids=evidence, request_key=key,
            outcome=payload.get('outcome'), expected_current_delivery_id=payload.get('expected_current_delivery_id'))
        if not isinstance(receipt, dict) or not receipt.get('id'):
            raise ValueError('Submission acknowledgement missing; reconcile before continuing')
        with self.db:
            previous = self.db.execute('SELECT receipt FROM queue WHERE key=?', (key,)).fetchone()[0]
            if previous and json.loads(previous)['id'] != receipt['id']:
                raise ValueError('Submission receipt conflict')
            self.db.execute('UPDATE queue SET receipt=? WHERE key=?', (_json(receipt), key))
        return receipt
