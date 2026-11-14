"""Host-side idempotent start admission.

The shared Test engine owns task launching, so this module does not start anything. It is the
gate a host uses *before* launching: one request key admits at most one logical run, and a
finished admission can never be launched a second time. That makes "repeat click / repeated
schedule does not double the business" a testable fact at the host boundary instead of an
assumption inherited from delivery idempotency.
"""
import json
import os
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path

_APP_ID = 0x4241444D  # 'BADM'
STATES = ('admitted', 'started', 'finished', 'abandoned')


def _ts():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


class StartAdmission:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=5, check_same_thread=False)
        self._lock = threading.Lock()
        identity = self.db.execute('PRAGMA application_id').fetchone()[0]
        tables = {r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if identity == 0 and not tables:
            with self.db:
                # Two processes/threads can initialise at once; IF NOT EXISTS keeps that a no-op
                # instead of a crash that would look like "admission unavailable".
                self.db.execute('''CREATE TABLE IF NOT EXISTS admissions(
                    request_key TEXT PRIMARY KEY, issue_id TEXT NOT NULL, execution_ref TEXT NOT NULL,
                    goal_version TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL,
                    started_at TEXT, finished_at TEXT, note TEXT)''')
                self.db.execute(f'PRAGMA application_id={_APP_ID}')
        elif identity != _APP_ID or tables != {'admissions'}:
            self.db.close()
            raise ValueError('Unrecognized admission store; do not reset')
        os.chmod(path, 0o600)

    def close(self):
        self.db.close()

    def _row(self, request_key):
        row = self.db.execute('SELECT request_key,issue_id,execution_ref,goal_version,state,created_at,started_at,finished_at,note '
                              'FROM admissions WHERE request_key=?', (request_key,)).fetchone()
        if row is None:
            return None
        return dict(zip(('requestKey', 'issueId', 'executionRef', 'goalVersion', 'state', 'createdAt',
                         'startedAt', 'finishedAt', 'note'), row))

    def admit(self, *, request_key, issue_id, execution_ref, goal_version=None):
        """Return {'shouldLaunch': bool, 'state': str}; idempotent per request key."""
        if not all(isinstance(v, str) and v.strip() for v in (request_key, issue_id, execution_ref)):
            raise ValueError('Request key, issue and execution reference are required')
        with self._lock:
            with self.db:
                # INSERT OR IGNORE makes two concurrent admits converge on one row.
                self.db.execute('INSERT OR IGNORE INTO admissions(request_key,issue_id,execution_ref,goal_version,state,created_at) '
                                'VALUES(?,?,?,?,?,?)', (request_key, issue_id, execution_ref, goal_version, 'admitted', _ts()))
            row = self._row(request_key)
            if (row['issueId'], row['executionRef'], row['goalVersion']) != (issue_id, execution_ref, goal_version):
                raise ValueError('Request key already admitted with different content; reconcile before launching')
            # The transition admitted -> started is the single launch ticket; rowcount decides the winner.
            with self.db:
                cursor = self.db.execute("UPDATE admissions SET state='started', started_at=? "
                                         "WHERE request_key=? AND state='admitted'", (_ts(), request_key))
                should_launch = cursor.rowcount == 1
            row = self._row(request_key)
        return {'shouldLaunch': should_launch, 'state': row['state'], 'admission': row}

    def finish(self, request_key, *, note=None):
        with self._lock:
            with self.db:
                self.db.execute("UPDATE admissions SET state='finished', finished_at=? WHERE request_key=? AND state='started'",
                                (_ts(), request_key))
                if note:
                    self.db.execute('UPDATE admissions SET note=? WHERE request_key=?', (note, request_key))
            return self._row(request_key)

    def abandon(self, request_key, *, note=None):
        with self._lock:
            with self.db:
                self.db.execute("UPDATE admissions SET state='abandoned', finished_at=? WHERE request_key=? AND state IN ('admitted','started')",
                                (_ts(), request_key))
                if note:
                    self.db.execute('UPDATE admissions SET note=? WHERE request_key=?', (note, request_key))
            return self._row(request_key)

    def get(self, request_key):
        return self._row(request_key)
