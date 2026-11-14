"""Typed runtime refusals. Kept dependency-free so both the transport and the outbox can use them."""


class DeliveryCancelled(RuntimeError):
    """The reviewed execution was cancelled. Re-sending the same key is not allowed."""

    code = 'cancelled'


class DeliveryRevoked(RuntimeError):
    """The grant expired or was revoked, or the assertion scope no longer matches."""

    code = 'revoked'
