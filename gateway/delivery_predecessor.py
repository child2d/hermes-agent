"""Wire the real turn entry to the delivery predecessor contract.

The runtime's ``run_turn`` emits ``agent:start`` with a context dict; the delivery consumer requires
``expected_current_delivery_id`` to be captured at admission ("" when there is no current delivery).
This helper is the single place that attaches it, so the wiring is greppable and testable instead of
being an implicit gap.
"""


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
