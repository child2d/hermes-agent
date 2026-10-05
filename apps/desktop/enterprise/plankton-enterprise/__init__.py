"""plankton-enterprise — the agent half of the enterprise plugin.

This batch ships NO agent tools, hooks or middleware: it is a deliberate no-op
registration. What matters is that the directory is a valid Hermes plugin so the
engine discovers it (and, separately, so the dashboard half's ``dashboard/`` is
found). The backend REST surface lives in ``dashboard/plugin_api.py`` and the
desktop half ships through the standalone desktop-plugin door.

Everything the plugin does is variant-independent and reads nothing secret.
"""

from __future__ import annotations

from typing import Any


def register(ctx: Any) -> None:  # noqa: ARG001 - the manifest contract requires the parameter
    """No agent-side registrations in this batch.

    Kept explicit (rather than empty) so the plugin loads cleanly and the
    manifest's required ``register(ctx)`` symbol exists. Writes nothing, reads
    no credential.
    """
    return None
