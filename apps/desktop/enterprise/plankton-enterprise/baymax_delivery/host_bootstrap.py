"""Trusted-host bootstrap: the only supported way to enable runtime delivery writeback.

Design rule: writeback cannot be enabled by handing the runtime a private key. The caller
must present a :class:`HostCustody` that already passed the key preconditions, plus an
explicit :class:`Binding` naming one issue / grant / execution. Everything else this module
needs is derived, and the report it returns contains only public material.
"""
from pathlib import Path

from .completion_hook import CompletionConsumer, configure_consumer
from .delivery_outbox import DeliveryOutbox
from .host_custody import CustodyError, HostCustody
from .runtime_bridge import Binding, ENDPOINT, SandboxTransport


def bootstrap_report(custody, binding):
    """Configuration a deployer needs, with the private key absent by construction."""
    if not isinstance(custody, HostCustody):
        raise CustodyError('A verified HostCustody is required; raw keys are not accepted')
    custody.ensure_open()
    if not isinstance(binding, Binding):
        raise CustodyError('An explicit runtime binding is required')
    statement = custody.statement()
    return {
        'endpoint': ENDPOINT,
        'agent_public_key_pem': custody.public_key_pem(),
        'BAYMAX_AGENT_PUBLIC_KEY': custody.public_key_pem(),
        'BAYMAX_AGENT_ISSUER': statement['issuer'],
        'BAYMAX_AGENT_AUDIENCE': ENDPOINT,
        'key_fingerprint': statement['fingerprint'],
        'binding': {'issue_id': binding.issue_id, 'grant_id': binding.grant_id,
                    'subject': binding.subject, 'delegator_id': binding.delegator_id,
                    'execution_ref': binding.execution_ref, 'deadline': binding.deadline},
        'custody_statement': statement,
    }


def build_consumer(*, custody, binding, state_path, intent_path, session_id, outbox_path, opener=None, register=True):
    """Wire the host-only completion consumer onto a custody-backed transport."""
    if not isinstance(custody, HostCustody):
        raise CustodyError('A verified HostCustody is required; raw keys are not accepted')
    custody.ensure_open()
    if not isinstance(binding, Binding):
        raise CustodyError('An explicit runtime binding is required')
    if not session_id or not isinstance(session_id, str):
        raise CustodyError('A pinned session id is required')
    for label, value in (('state_path', state_path), ('intent_path', intent_path), ('outbox_path', outbox_path)):
        if not value:
            raise CustodyError('Missing runtime path: ' + label)
    # A key that lives inside the agent-facing workspace is refused by HostCustody before this point.
    transport = SandboxTransport(custody.issuer, opener=opener)
    outbox = DeliveryOutbox(Path(outbox_path))
    consumer = CompletionConsumer(state_path, intent_path, session_id, outbox, transport=transport)
    if register:
        configure_consumer(consumer)
    return consumer, transport, outbox
