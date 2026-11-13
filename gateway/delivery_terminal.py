"""Deliverable turn identity for the delivery event.

A delivery event must name the row the transcript actually recorded, not the display text the
gateway chose to show. The display text can carry a footer, reasoning or a failure notice that is
never re-written into ``messages.content``, so comparing against it rejects honest turns. The row
id is the identity; ``session_id`` is the session the row belongs to (a ``/new`` during the turn
can move the session, so the caller passes the persisted id, not the one captured at admission).

Only a truly terminal row counts: an assistant row that still carries ``tool_calls`` is a mid-turn
step, not an outcome. Nothing here writes to the transcript.
"""

TERMINAL_ROLES = ("assistant",)


async def terminal_identity(store, session_id):
    """Return ``{message_id, session_id, display_kind, finish_reason}`` for a terminal row, or None.

    ``store`` is the gateway's canonical store facade (``async_session_store``); its
    ``get_messages`` is awaited here. ``None`` means "this run has no provable terminal yet" and
    callers must keep the delivery pending instead of inventing one.
    """
    if not session_id:
        return None
    rows = await store.get_messages(session_id)
    if not rows:
        return None
    row = rows[-1]
    if row.get("role") not in TERMINAL_ROLES:
        return None
    if row.get("tool_calls"):
        return None
    message_id = row.get("id")
    if message_id is None:
        return None
    return {"message_id": message_id, "session_id": session_id,
            "display_kind": row.get("display_kind"), "finish_reason": row.get("finish_reason")}
