"""Wire the real turn entry to the delivery predecessor contract.

The runtime's ``run_turn`` emits ``agent:start`` with a context dict; the delivery consumer requires
``expected_current_delivery_id`` to be captured at admission ("" when there is no current delivery).
This helper is the single place that attaches it, so the wiring is greppable and testable instead of
being an implicit gap. The whole hook context is built here so ``run_turn`` carries no
delivery-specific plumbing (and no line-budget growth).
"""

import uuid


def new_execution_ref() -> str:
    """A fresh per-run reference. Unique per turn; never derived from message content."""
    return f"plankton-run:{uuid.uuid4()}"


def attach_predecessor(context, provider):
    """Attach the captured predecessor to a hook context.

    ``provider`` must be a zero-argument callable returning a delivery id or "" (no current
    delivery). A missing provider is *recorded*, never guessed: the consumer will refuse the run as
    ``blocked_predecessor`` instead of silently submitting against an unknown head.
    """
    if not isinstance(context, dict):
        raise TypeError('hook context must be a dict')
    if provider is None:
        context['expected_current_delivery_id'] = None
        context['delivery_predecessor_missing'] = True
        return context
    value = provider()  # any failure propagates: the turn must not start without a predecessor
    if not isinstance(value, str):
        raise TypeError('predecessor provider must return a string ("" for none)')
    context['expected_current_delivery_id'] = value
    context.pop('delivery_predecessor_missing', None)
    return context


def build_hook_ctx(*, source, session_entry, message_text, predecessor_provider):
    """The turn's hook context: identity, transcript session, the run reference and the predecessor."""
    context = {
        "execution_ref": new_execution_ref(),
        "platform": source.platform.value if source.platform else "",
        "user_id": source.user_id,
        "chat_id": source.chat_id or "",
        "thread_id": str(source.thread_id) if getattr(source, "thread_id", None) else "",
        "chat_type": getattr(source, "chat_type", "") or "",
        "session_id": session_entry.session_id,
        "message": message_text[:500],
    }
    return attach_predecessor(context, predecessor_provider)
