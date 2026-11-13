"""Optional delivery notification.

The gateway knows a turn finished; it does **not** know which canonical row is that turn's terminal.
This repository's persistence path cannot name it: ``append_to_transcript`` returns ``None`` and
queues the write, and an agent-persisted turn writes nothing here at all. So the notification is
inert unless a host integration explicitly supplies a receipt provider that returns the id the
*persistence call itself* produced (``source='append_return'``). No provider -> no read, no emit.

A failure inside the provider is logged and swallowed: an optional delivery notification must never
turn a finished turn into an error reply or make the user retry.
"""

import logging

logger = logging.getLogger("gateway.delivery_notify")

RECEIPT_SOURCE = "append_return"


async def notify_delivery_ready(*, hooks, provider, session_entry, agent_result, response,
                                outcome, hook_ctx=None, run_ref=None):
    """Emit ``agent:delivery-ready`` only when a verified receipt exists. Returns True if emitted."""
    if provider is None:
        return False
    try:
        receipt = provider(session_entry=session_entry, agent_result=agent_result, response=response)
        if not receipt:
            return False
        message_id = receipt.get("message_id")
        session_id = receipt.get("session_id")
        if message_id is None or not session_id:
            logger.warning("delivery-ready skipped: provider returned no message id/session")
            return False
        await hooks.emit("agent:delivery-ready", {
            **(hook_ctx or {}),
            "session_id": session_id,
            "canonical_message_id": message_id,
            "terminal_run": receipt.get("run") or run_ref,
            "terminal_source": receipt.get("source") or RECEIPT_SOURCE,
            "outcome": outcome,
            "response": response or "",
        })
        return True
    except Exception as error:  # never let a notification break the reply path
        logger.warning("delivery-ready notification skipped: %s", type(error).__name__)
        return False
