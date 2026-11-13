import _path_setup
"""Installed HookRegistry integration; staged source-order check is not a live run."""
import ast
import asyncio
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from baymax_delivery.completion_hook import CompletionConsumer
from baymax_delivery.delivery_outbox import DeliveryOutbox

ROOT = _path_setup.PACKAGE_ROOT
REPO = _path_setup.REPO_ROOT

class NativeHookTests(unittest.TestCase):
    def test_new_ready_event_follows_failure_classification_and_persistence(self):
        tree = ast.parse((REPO/'gateway/run_turn.py').read_text())
        lines = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in ('_hmwa_classify_turn_failure','_hmwa_persist_turn_transcript'):
                    lines[node.func.attr] = node.lineno
                if node.func.attr == 'emit' and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == 'agent:delivery-ready':
                    lines['ready'] = node.lineno
        self.assertIn('ready', lines)
        self.assertGreater(lines['ready'], lines['_hmwa_persist_turn_transcript'])
        self.assertGreater(lines['ready'], lines['_hmwa_classify_turn_failure'])

    def test_installed_registry_discovers_adapter_and_records_start_without_network(self):
        package = os.environ.get('HERMES_PACKAGE_ROOT') or str(REPO)
        if not package: self.fail('Run with the discovered installed HERMES_PACKAGE_ROOT; do not replace registry with a mock')
        sys.path.insert(0, package)
        import gateway.hooks as native
        from baymax_delivery import completion_hook
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); state=root/'state.db'
            with closing(sqlite3.connect(state)) as db, db:
                db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,display_kind TEXT)')
            outbox=DeliveryOutbox(root/'outbox.sqlite')
            consumer=CompletionConsumer(state,root/'intents.sqlite','unit-session',outbox)
            completion_hook.configure_consumer(consumer)
            previous=native.HOOKS_DIR
            try:
                native.HOOKS_DIR=ROOT/'hooks'
                registry=native.HookRegistry(); registry.discover_and_load()
                self.assertEqual(len(registry.loaded_hooks),1)
                context={'session_id':'unit-session','execution_ref':'unit-registry-run','expected_current_delivery_id':''}
                asyncio.run(registry.emit('agent:start',context))
                with closing(sqlite3.connect(root/'intents.sqlite')) as db:
                    self.assertEqual(db.execute('SELECT execution_ref FROM intents').fetchone()[0],'unit-registry-run')
                asyncio.run(registry.emit('agent:end',context))
                self.assertEqual(outbox.db.execute('SELECT COUNT(*) FROM queue').fetchone()[0],0)
                with closing(sqlite3.connect(state)) as db, db:
                    db.execute('INSERT INTO messages(session_id,role,content) VALUES(?,?,?)',('unit-session','assistant','Explicit native-adapter test output'))
                ready={**context,'response':'Explicit native-adapter test output','outcome':'completed'}
                asyncio.run(registry.emit('agent:delivery-ready',ready))
                self.assertEqual(outbox.db.execute('SELECT COUNT(*) FROM queue').fetchone()[0],0)
                # Only the remote API is a double here. Registry dispatch, persisted
                # terminal verification, worker threads and SQLite recovery are real.
                from types import SimpleNamespace
                calls=[]
                binding=SimpleNamespace(execution_ref='unit-registry-run',issue_id='42')
                def register(**kwargs): calls.append('evidence'); return {'id':'unit-evidence-'+str(len(calls))}
                def submit(**kwargs): calls.append('submit'); return {'id':'unit-delivery','version':kwargs['version']}
                consumer.transport=SimpleNamespace(issuer=SimpleNamespace(binding=binding,require_binding=lambda:binding),register_evidence=register,submit_delivery=submit)
                async def recover():
                    await registry.emit('gateway:startup',{})
                    for _ in range(200):
                        with closing(sqlite3.connect(root/'intents.sqlite')) as db:
                            if db.execute('SELECT receipt FROM intents').fetchone()[0]: break
                        await asyncio.sleep(.01)
                    else: self.fail('Background writeback receipt absent')
                    await registry.emit('agent:delivery-ready',ready)
                asyncio.run(recover())
                self.assertEqual(calls,['evidence','evidence','submit'])
                self.assertEqual(consumer.pending_runs(),[])
            finally:
                native.HOOKS_DIR=previous
                completion_hook.configure_consumer(None)
                outbox.close()

if __name__ == '__main__': unittest.main()
