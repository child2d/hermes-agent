"""Clean-process discovery probe (no plugin path, no pre-import).

The installer runs in a separate process (see the test). This process starts with only the
repository root on ``sys.path`` — never the plugin directory — and never imports ``baymax_delivery``
before discovery. The hook's handler can therefore only resolve the package through the
``plugin_root.txt`` the installer wrote. The consumer is configured from the module that discovery
itself loaded.

Usage: probe.py discover|bare <hermes_home> <plugin_root> <repo_root>

Exit code 0 means the observation matched the mode's expectation.
"""

import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path


def main():
    mode = sys.argv[1]
    hermes_home = Path(sys.argv[2]).resolve()
    plugin_root = Path(sys.argv[3]).resolve()
    repo_root = Path(sys.argv[4]).resolve()
    os.environ['HERMES_HOME'] = str(hermes_home)
    sys.path.insert(0, str(repo_root))

    pre = {'pluginRootOnPath': str(plugin_root) in sys.path,
           'preimported': 'baymax_delivery' in sys.modules}

    from gateway.hooks import HookRegistry

    registry = HookRegistry()
    registry.discover_and_load()
    loaded = registry.loaded_hooks
    report = {'mode': mode, 'hooks': [h['name'] for h in loaded], **pre,
              'importableAfterDiscovery': 'baymax_delivery' in sys.modules}

    if mode == 'discover':
        # Discovery imported the handler, whose pointer put the plugin directory on sys.path.
        from baymax_delivery.completion_hook import CompletionConsumer, configure_consumer
        from baymax_delivery.delivery_outbox import DeliveryOutbox
        from hermes_state import SessionDB

        work = hermes_home / 'work'
        work.mkdir(parents=True, exist_ok=True)
        store = SessionDB(db_path=work / 'state.db')
        store.create_session('probe-session', 'test')
        outbox = DeliveryOutbox(work / 'outbox.sqlite3')
        consumer = CompletionConsumer(work / 'state.db', work / 'intents.sqlite', 'probe-session', outbox)
        configure_consumer(consumer)
        context = {'session_id': 'probe-session', 'execution_ref': 'probe-run-1',
                   'expected_current_delivery_id': ''}
        asyncio.run(registry.emit_collect('agent:start', context))
        message_id = store.append_message('probe-session', 'assistant', 'probe output',
                                          display_kind='final')
        ready = asyncio.run(registry.emit_collect('agent:delivery-ready', {
            **context, 'canonical_message_id': message_id, 'terminal_run': 'probe-run-1',
            'terminal_source': 'append_return', 'response': 'display text with footer',
            'outcome': 'completed'}))
        duplicates = asyncio.run(registry.emit_collect('agent:start', context))
        with sqlite3.connect(work / 'intents.sqlite') as db:
            row = db.execute('SELECT execution_ref, predecessor, payload FROM intents').fetchone()
        payload = json.loads(row[2]) if row and row[2] else None
        outbox.close()
        try:
            store.close()
        except Exception:
            pass
        report.update({
            'ready': (ready or [None])[0], 'duplicateStart': (duplicates or [None])[0],
            'intentRow': [row[0], row[1]] if row else None,
            'payloadSummary': payload['summary'] if payload else None,
            'payloadTerminalId': payload['terminal_message_id'] if payload else None,
        })
        expected = (report['hooks'] == ['baymax-delivery-bridge']
                    and report['intentRow'] == ['probe-run-1', '']
                    and report['payloadTerminalId'] == message_id
                    and pre['pluginRootOnPath'] is False and pre['preimported'] is False)
    else:
        expected = (report['hooks'] == [] and pre['pluginRootOnPath'] is False
                    and pre['preimported'] is False and report['importableAfterDiscovery'] is False)
    report['expected'] = expected
    print(json.dumps(report))
    return 0 if expected else 1


if __name__ == '__main__':
    raise SystemExit(main())
