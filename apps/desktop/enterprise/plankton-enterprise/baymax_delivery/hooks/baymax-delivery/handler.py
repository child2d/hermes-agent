"""Native HookRegistry adapter: forwards agent events to the scoped delivery consumer.

Installed by ``python -m baymax_delivery.hooks.install``, which writes ``plugin_root.txt`` next to
this file. The gateway imports a hook's handler without extending ``sys.path``, so this pointer is
the supported way for the handler to reach the package it belongs to. Without the pointer (a copy
made by hand) the import fails loudly instead of silently disabling delivery.
"""

import pathlib
import sys

_HERE = pathlib.Path(__file__).resolve().parent
_POINTER = _HERE / 'plugin_root.txt'
if _POINTER.exists():
    _root = _POINTER.read_text().strip()
    if _root and _root not in sys.path:
        sys.path.insert(0, _root)

from baymax_delivery.completion_hook import dispatch


async def handle(event_type, context):
    return await dispatch(event_type, context)
