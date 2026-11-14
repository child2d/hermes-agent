"""OPT-IN probe for ONE approved, fresh pending run. This can perform live writes.

Never schedules or repeats business execution. It deliberately discards each first
successful evidence/delivery acknowledgement BEFORE the outbox can save it, then
reopens SQLite and reconciles against authenticated server reads. This is not OS
process-kill or packet-loss testing. Unbound use is refused before any network IO.
"""
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from .delivery_outbox import DeliveryOutbox, _APPLICATION_ID
from .runtime_bridge import ENDPOINT

class InjectedReceiptLoss(RuntimeError):
    def __init__(self, operation):
        self.operation = operation
        super().__init__('Injected acknowledgement loss AFTER remote success: ' + operation)

class _LoseFirstAcknowledgements:
    def __init__(self, transport):
        self.transport = transport
        self.observed = {}
        self.points = []

    def register_evidence(self, **kwargs):
        receipt = self.transport.register_evidence(**kwargs)
        key = kwargs['request_key']
        previous = self.observed.get(('evidence', key))
        if previous is not None and receipt != previous:
            raise AssertionError('Evidence retry returned a different acknowledgement')
        self.observed[('evidence', key)] = receipt
        if 'evidence' not in self.points:
            self.points.append('evidence')
            raise InjectedReceiptLoss('evidence')
        return receipt

    def read_receipt(self, **kwargs):
        return self.transport.read_receipt(**kwargs)

    def submit_delivery(self, **kwargs):
        receipt = self.transport.submit_delivery(**kwargs)
        key = kwargs['request_key']
        previous = self.observed.get(('delivery', key))
        if previous is not None and receipt != previous:
            raise AssertionError('Delivery retry returned a different acknowledgement')
        self.observed[('delivery', key)] = receipt
        if 'delivery' not in self.points:
            self.points.append('delivery')
            raise InjectedReceiptLoss('delivery')
        return receipt


def run_ack_loss_probe(outbox_path, key, transport):
    binding = transport.issuer.require_binding()  # Fail closed BEFORE opening storage or network.
    path = Path(outbox_path).resolve()
    if not path.is_file():
        raise ValueError('Existing approved pending outbox required')
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA application_id').fetchone()[0] != _APPLICATION_ID:
            raise ValueError('Not a delivery outbox; do not modify')
        row = db.execute('SELECT payload,receipt FROM queue WHERE key=?', (key,)).fetchone()
        if row is None or row[1] is not None:
            raise ValueError('Fresh pending execution required; do not probe completed work')
        if db.execute('SELECT COUNT(*) FROM uploads WHERE queue_key=?', (key,)).fetchone()[0]:
            raise ValueError('Probe needs fresh pending uploads; use normal recovery instead')
    payload = json.loads(row[0])
    if payload['endpoint'] != ENDPOINT or payload['issue_id'] != binding.issue_id or payload['execution_ref'] != binding.execution_ref:
        raise ValueError('Probe does not match the approved runtime binding')
    before = transport.read_state(endpoint=ENDPOINT, issue_id=binding.issue_id)
    if any(item['version'] == payload['version'] for item in before['history']['deliveries']):
        raise ValueError('Version already exists; reconcile rather than start fault injection')
    fault = _LoseFirstAcknowledgements(transport)
    outcomes = []
    for expected in ('evidence', 'delivery'):
        outbox = DeliveryOutbox(path)
        try:
            try:
                outbox.resume(key, fault)
            except InjectedReceiptLoss as loss:
                if loss.operation != expected:
                    raise AssertionError('Wrong fault-injection boundary')
                # Nothing committed for this point yet: the same key stays pending.
                outcomes.append({'point': expected, 'outcome': 'pending_same_key'})
            else:
                # The lost acknowledgement was adopted from authenticated server truth, no rewrite.
                outcomes.append({'point': expected, 'outcome': 'reconciled_from_server'})
        finally:
            outbox.close()
    outbox = DeliveryOutbox(path)
    try:
        receipt = outbox.resume(key, fault)
        evidence_ids = [json.loads(row[0])['id'] for row in outbox.db.execute('SELECT receipt FROM uploads WHERE queue_key=? ORDER BY slot', (key,))]
    finally:
        outbox.close()
    after = transport.read_state(endpoint=ENDPOINT, issue_id=binding.issue_id)
    versions = [item for item in after['history']['deliveries'] if item['version'] == payload['version'] and item['execution_ref'] == binding.execution_ref]
    if len(versions) != 1 or versions[0]['id'] != receipt['id'] or versions[0]['evidence_ids'] != evidence_ids:
        raise AssertionError('Server readback does not confirm one identical delivery and evidence list')
    old_evidence = {item['id'] for item in before['evidence']}
    new_evidence = {item['id'] for item in after['evidence']} - old_evidence
    if new_evidence != set(evidence_ids):
        raise AssertionError('Server evidence inventory changed beyond the expected receipts; reconcile concurrent writes')
    if any(sum(item['id'] == evidence_id for item in after['evidence']) != 1 for evidence_id in evidence_ids):
        raise AssertionError('Server evidence acknowledgement missing or duplicated')
    return {'execution_ref': binding.execution_ref, 'lost_ack_points': fault.points,
            'ack_loss_outcomes': outcomes,
            'evidence_ids': evidence_ids, 'delivery_id': receipt['id'], 'version': receipt['version'],
            'server_readback_verified': True, 'business_execution_verified': False,
            'recovery_invoked_business_executor': False}
