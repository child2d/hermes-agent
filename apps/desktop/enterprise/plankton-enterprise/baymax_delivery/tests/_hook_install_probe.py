"""Subprocess probe: install the hook into an isolated profile, then let the REAL registry drive it.

Run as ``python _hook_install_probe.py <hermes_home> <plugin_root> <repo_root>``. Nothing here
patches ``HOOKS_DIR``, and the handler is not given the plugin directory by this process: the
installer writes the pointer file and the gateway's own ``HookRegistry``/``import_user_code`` load
it exactly as in production. The canonical store is the repository's real ``SessionDB``.
"""

import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path


def main():
    hermes_home = Path(sys.argv[1]).resolve()
    plugin_root = Path(sys.argv[2]).resolve()
    repo_root = Path(sys.argv[3]).resolve()
    os.environ['HERMES_HOME'] = str(hermes_home)
    sys.path.insert(0, str(plugin_root))
    sys.path.insert(0, str(repo_root))

    from baymax_delivery.completion_hook import CompletionConsumer, configure_consumer
    from baymax_delivery.delivery_outbox import DeliveryOutbox
    from baymax_delivery.hooks.install import install
    from hermes_state import SessionDB

    plan = install(hermes_home)

    from gateway.hooks import HookRegistry

    registry = HookRegistry()
    registry.discover_and_load()
    loaded = registry.loaded_hooks

    work = hermes_home / 'work'
    work.mkdir(parents=True, exist_ok=True)
    store = SessionDB(db_path=work / 'state.db')
    store.create_session('probe-session', 'test')
    outbox = DeliveryOutbox(work / 'outbox.sqlite3')
    consumer = CompletionConsumer(work / 'state.db', work / 'intents.sqlite', 'probe-session', outbox)
    configure_consumer(consumer)

    context = {'session_id': 'probe-session', 'execution_ref': 'probe-run-1',
               'expected_current_delivery_id': ''}
    started = asyncio.run(registry.emit_collect("agent:start", context))
    ended = asyncio.run(registry.emit_collect("agent:end", context))
    message_id = store.append_message('probe-session', 'assistant', 'probe output', display_kind='final')
    ready = asyncio.run(registry.emit_collect("agent:delivery-ready",
                                      {**context, 'canonical_message_id': message_id,
                                       'response': 'display text with footer', 'outcome': 'completed'}))
    with sqlite3.connect(work / 'intents.sqlite') as db:
        row = db.execute('SELECT execution_ref, predecessor, payload FROM intents').fetchone()
    payload = json.loads(row[2]) if row and row[2] else None
    duplicates = asyncio.run(registry.emit_collect("agent:start", context))
    outbox.close()
    try:
        store.close()
    except Exception:
        pass
    print(json.dumps({
        'installedTo': plan['target'],
        'hooks': [h['name'] for h in loaded],
        'events': loaded[0]['events'] if loaded else [],
        'start': (started or [None])[0], 'end': (ended or [None])[0],
        'ready': (ready or [None])[0], 'duplicateStart': (duplicates or [None])[0],
        'intentRow': [row[0], row[1]] if row else None,
        'payloadSummary': payload['summary'] if payload else None,
        'payloadTerminalId': payload['terminal_message_id'] if payload else None,
    }))


if __name__ == '__main__':
    main()
