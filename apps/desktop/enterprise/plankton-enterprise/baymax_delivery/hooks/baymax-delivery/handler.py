"""Native HookRegistry adapter: forwards agent events to the scoped delivery consumer."""
from baymax_delivery.completion_hook import dispatch


async def handle(event_type, context):
    return await dispatch(event_type, context)
