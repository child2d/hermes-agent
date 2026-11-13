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


def delivery_receipt_enabled(hooks) -> bool:
    """True when a delivery consumer is installed for this profile.

    Checked before persistence reaches for any delivery-specific work, so the default install (no
    Baymax hook) performs zero delivery I/O — including the agent-persisted uid lookup.
    """
    try:
        return bool(hooks.has_handlers("agent:delivery-ready"))
    except (AttributeError, TypeError):
        return False


async def notify_turn_receipt(*, hooks, provider, session_entry, agent_result, response,
                              outcome, hook_ctx, receipt) -> bool:
    """Emit this turn's ``agent:delivery-ready`` from the persistence receipt alone.

    The caller passes no run reference: the receipt carries it, so the notification cannot invent the
    binding the consumer is supposed to verify.
    """
    return await notify_delivery_ready(
        hooks=hooks,
        provider=provider or ((lambda **_: receipt) if receipt else None),
        session_entry=session_entry,
        agent_result=agent_result,
        response=response,
        outcome=outcome,
        hook_ctx=hook_ctx,
    )


async def notify_delivery_ready(*, hooks, provider, session_entry, agent_result, response,
                                outcome, hook_ctx=None):
    """Emit ``agent:delivery-ready`` only when a *complete* verified receipt exists.

    The receipt must carry the run it belongs to and the session the row landed in; this helper
    never fills either in (that would let the notification manufacture the very binding the
    consumer is supposed to verify). Returns True only when the event was emitted.
    """
    if provider is None:
        return False
    try:
        receipt = provider(session_entry=session_entry, agent_result=agent_result, response=response)
        if not receipt:
            return False
        message_id = receipt.get("message_id")
        session_id = receipt.get("session_id")
        run = receipt.get("run")
        if message_id is None or not session_id or not run:
            logger.warning("delivery-ready skipped: receipt lacks message id/session/run")
            return False
        await hooks.emit("agent:delivery-ready", {
            **(hook_ctx or {}),
            "session_id": session_id,
            "canonical_message_id": message_id,
            "terminal_run": run,
            "terminal_source": receipt.get("source") or RECEIPT_SOURCE,
            "outcome": outcome,
            "response": response or "",
        })
        return True
    except (OSError, RuntimeError, ValueError, TypeError) as error:  # never break the reply path
        logger.warning("delivery-ready notification skipped: %s", type(error).__name__, exc_info=True)
        return False
