import _path_setup  # noqa: F401  (puts the plugin directory on sys.path)
"""Real SQLite recovery tests; remote transport is explicitly an in-memory test double."""
import os
import tempfile
import unittest
from pathlib import Path
import baymax_delivery.delivery_outbox as delivery_outbox


class TransportDouble:
    def __init__(self):
        self.evidence_calls = 0
        self.submit_calls = 0
        self.evidence_receipts = {}
        self.delivery_receipts = {}
        self.fail_submit_once = False
        self.lose_evidence_ack_once = False
        self.commit_then_fail_once = False
        self.receipt_reads = 0
        self.delivery_payloads = []

    def read_receipt(self, **data):
        self.receipt_reads += 1
        store = self.evidence_receipts if data['operation'] == 'evidence' else self.delivery_receipts
        return store.get(data['request_key'])

    def register_evidence(self, **data):
        self.evidence_calls += 1
        key = data['request_key']
        result = self.evidence_receipts.setdefault(key, {'id': 'test-evidence-' + str(len(self.evidence_receipts))})
        if self.lose_evidence_ack_once:
            self.lose_evidence_ack_once = False
            raise TimeoutError('Test-only lost evidence acknowledgement')
        return result

    def submit_delivery(self, **data):
        self.submit_calls += 1
        self.delivery_payloads.append(dict(data))
        if self.fail_submit_once:
            self.fail_submit_once = False
            raise TimeoutError('Test-only submit failure')
        receipt = self.delivery_receipts.setdefault(data['request_key'], {'id': 'test-delivery', 'version': data['version']})
        if self.commit_then_fail_once:
            # The server committed the delivery; only the acknowledgement was lost.
            self.commit_then_fail_once = False
            raise TimeoutError('Test-only lost submit acknowledgement')
        return receipt


class OutboxTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(os.environ['TMPDIR'])
        self.directory = tempfile.TemporaryDirectory(dir=scratch, prefix='baymax-outbox-unit-')
        self.path = Path(self.directory.name) / 'outbox.sqlite'
        self.publisher = delivery_outbox.DeliveryOutbox(self.path)
        self.input = dict(endpoint='https://baymax-bff-sandbox.shaoke.com/graphql', issue_id='42', execution_ref='unit-run:1',
                          version='unit-v1', summary='Unit test output, not a real delivery', unfinished=None,
                          artifacts=[{'name': 'unit.txt', 'content': 'Explicit test evidence'}],
                          expected_current_delivery_id='')

    def tearDown(self):
        if hasattr(self, 'publisher'): self.publisher.close()
        self.directory.cleanup()

    def test_missing_predecessor_is_refused_at_prepare_time(self):
        with self.assertRaises(ValueError):
            self.publisher.enqueue(**{k: v for k, v in self.input.items() if k != 'expected_current_delivery_id'})
        with self.assertRaises(ValueError):
            self.publisher.enqueue(**{**self.input, 'expected_current_delivery_id': None})

    def test_reconcile_mismatch_keeps_pending_and_never_resubmits(self):
        class Mismatching(TransportDouble):
            def read_receipt(self, **data):
                self.receipt_reads += 1
                raise RuntimeError('Delivery receipt payload mismatch on summary; keep pending')
        transport = Mismatching(); transport.commit_then_fail_once = True
        key = self.publisher.enqueue(**self.input)
        with self.assertRaises(TimeoutError):
            self.publisher.resume(key, transport)
        submits_before = transport.submit_calls
        with self.assertRaises(RuntimeError):
            self.publisher.resume(key, transport)
        # No second write while the server truth cannot be confirmed.
        self.assertEqual(transport.submit_calls, submits_before)
        self.assertTrue(self.publisher.is_attempt_unconfirmed(key))

    def test_reconcile_passes_the_whole_frozen_payload(self):
        seen = {}
        class Recording(TransportDouble):
            def read_receipt(self, **data):
                if data['operation'] == 'evidence':
                    return {'id': 'test-evidence-replay'}
                seen.update(data.get('expected') or {})
                return {'id': 'test-delivery', 'version': data['expected']['version']}
        transport = Recording()
        key = self.publisher.enqueue(**self.input)
        self.publisher._mark_attempt(key)
        confirmed = self.publisher.resume(key, transport)
        self.assertEqual(confirmed['id'], 'test-delivery')
        self.assertEqual(seen['summary'], self.input['summary'])
        self.assertEqual(seen['executionRef'], self.input['execution_ref'])
        self.assertEqual(seen['expectedCurrentDeliveryId'], '')
        self.assertIn('evidenceIds', seen)
        self.assertEqual(transport.submit_calls, 0)  # resolved from server truth, no second write

    def test_restart_reuses_registered_evidence_and_only_retries_writeback(self):
        transport = TransportDouble(); transport.fail_submit_once = True
        key = self.publisher.enqueue(**self.input)
        with self.assertRaises(TimeoutError): self.publisher.resume(key, transport)
        self.assertEqual(transport.evidence_calls, 1)
        self.publisher.close(); self.publisher = delivery_outbox.DeliveryOutbox(self.path)
        receipt = self.publisher.resume(key, transport)
        self.assertEqual(receipt['id'], 'test-delivery')
        self.assertEqual(transport.evidence_calls, 1)
        self.assertEqual(transport.submit_calls, 2)
        self.publisher.resume(key, transport)
        self.assertEqual(transport.submit_calls, 2)

    def test_lost_evidence_ack_reuses_the_same_server_idempotency_key(self):
        transport = TransportDouble(); transport.lose_evidence_ack_once = True
        key = self.publisher.enqueue(**self.input)
        with self.assertRaises(TimeoutError): self.publisher.resume(key, transport)
        self.publisher.resume(key, transport)
        # The lost acknowledgement is adopted from server truth, so the upload is never repeated.
        self.assertEqual(transport.evidence_calls, 1)
        self.assertEqual(len(transport.evidence_receipts), 1)

    def test_lost_submit_ack_is_resolved_from_server_truth_without_resubmitting(self):
        transport = TransportDouble(); transport.commit_then_fail_once = True
        key = self.publisher.enqueue(**self.input)
        receipt = self.publisher.resume(key, transport)
        self.assertEqual(receipt['id'], 'test-delivery')
        self.assertEqual(transport.submit_calls, 1)
        self.assertGreaterEqual(transport.receipt_reads, 1)
        self.publisher.resume(key, transport)
        self.assertEqual(transport.submit_calls, 1)

    def test_uncommitted_failure_stays_pending_and_reuses_the_same_key(self):
        transport = TransportDouble(); transport.fail_submit_once = True
        key = self.publisher.enqueue(**self.input)
        with self.assertRaises(TimeoutError): self.publisher.resume(key, transport)
        row = self.publisher.db.execute('SELECT receipt FROM queue WHERE key=?', (key,)).fetchone()
        self.assertIsNone(row[0])
        self.assertEqual(self.publisher.resume(key, transport)['id'], 'test-delivery')
        self.assertEqual(transport.submit_calls, 2)
        self.assertEqual(len(transport.delivery_receipts), 1)

    def test_cancelled_execution_is_recorded_and_never_retried(self):
        from baymax_delivery.delivery_errors import DeliveryCancelled

        class Cancelling(TransportDouble):
            def submit_delivery(self, **data):
                self.submit_calls += 1
                raise DeliveryCancelled('Test-only server refusal: execution cancelled')

        transport = Cancelling()
        key = self.publisher.enqueue(**self.input)
        with self.assertRaises(DeliveryCancelled): self.publisher.resume(key, transport)
        self.assertTrue(self.publisher.is_cancelled(key))
        self.assertIsNone(self.publisher.db.execute('SELECT receipt FROM queue WHERE key=?', (key,)).fetchone()[0])
        with self.assertRaises(DeliveryCancelled): self.publisher.resume(key, transport)
        self.assertEqual(transport.submit_calls, 1)  # no retry after the cancellation was observed

    def test_revoked_grant_keeps_the_outbox_pending_for_a_new_grant(self):
        from baymax_delivery.delivery_errors import DeliveryRevoked

        class Revoking(TransportDouble):
            def submit_delivery(self, **data):
                self.submit_calls += 1
                raise DeliveryRevoked('Test-only server refusal: grant revoked')

        transport = Revoking()
        key = self.publisher.enqueue(**self.input)
        with self.assertRaises(DeliveryRevoked): self.publisher.resume(key, transport)
        self.assertFalse(self.publisher.is_cancelled(key))
        self.assertIsNone(self.publisher.db.execute('SELECT receipt FROM queue WHERE key=?', (key,)).fetchone()[0])

    def test_older_outbox_without_cancellation_column_is_migrated_additively(self):
        import sqlite3
        path = Path(self.directory.name) / 'older.sqlite'
        raw = sqlite3.connect(path)
        with raw:
            raw.execute('CREATE TABLE queue (key TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT)')
            raw.execute('CREATE TABLE uploads (queue_key TEXT NOT NULL, slot INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(queue_key,slot))')
            raw.execute('PRAGMA application_id=%d' % delivery_outbox._APPLICATION_ID)
        raw.close()
        migrated = delivery_outbox.DeliveryOutbox(path)
        try:
            columns = {row[1] for row in migrated.db.execute('PRAGMA table_info(queue)')}
            self.assertIn('cancelled_at', columns)
            self.assertFalse(migrated.is_cancelled(migrated.enqueue(**self.input)))
        finally:
            migrated.close()

    def test_reconcile_unavailable_keeps_pending_without_writing_again(self):
        class Unreachable(TransportDouble):
            def read_receipt(self, **data):
                raise RuntimeError('Test-only receipt query unavailable')

        transport = TransportDouble(); transport.fail_submit_once = True
        key = self.publisher.enqueue(**self.input)
        with self.assertRaises(TimeoutError): self.publisher.resume(key, transport)
        self.assertTrue(self.publisher.is_attempt_unconfirmed(key))
        unreachable = Unreachable(); unreachable.fail_submit_once = False
        with self.assertRaises(RuntimeError): self.publisher.resume(key, unreachable)
        self.assertEqual(unreachable.submit_calls, 0)  # never wrote again before reconciling
        self.assertIsNone(self.publisher.db.execute('SELECT receipt FROM queue WHERE key=?', (key,)).fetchone()[0])

    def test_reported_business_outcome_travels_with_the_delivery(self):
        transport = TransportDouble()
        key = self.publisher.enqueue(**{**self.input, 'outcome': 'failed'})
        self.publisher.resume(key, transport)
        self.assertEqual(transport.delivery_payloads[-1]['outcome'], 'failed')
        with self.assertRaises(ValueError):
            self.publisher.enqueue(**{**self.input, 'outcome': 'probably-fine'})

    def test_changed_content_cannot_replace_an_enqueued_execution_version(self):
        self.publisher.enqueue(**self.input)
        with self.assertRaises(ValueError): self.publisher.enqueue(**{**self.input, 'summary': 'Changed output'})

    def test_production_target_and_unconfirmed_issue_are_rejected(self):
        for change in [{'endpoint': 'https://baymax.shaoke.com/graphql'}, {'issue_id': ''}, {'issue_id': 'PM-3883'}]:
            with self.assertRaises(ValueError): self.publisher.enqueue(**{**self.input, **change})


if __name__ == '__main__': unittest.main()
