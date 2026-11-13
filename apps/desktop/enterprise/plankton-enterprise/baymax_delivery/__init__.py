"""Baymax AI delivery bridge: scoped writeback, outbox, completion consumer, host custody.
"""
"""All capabilities here are disabled by default; nothing writes without an explicit
trusted bootstrap (``host_bootstrap``) and a captured predecessor (``gateway.delivery_predecessor``).
"""
