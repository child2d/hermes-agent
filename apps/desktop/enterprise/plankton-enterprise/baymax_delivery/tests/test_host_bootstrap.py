import _path_setup  # noqa: F401  (puts the plugin directory on sys.path)
"""Bootstrap refuses raw keys, publishes only public material, and reaches no network here."""
import os
import tempfile
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from baymax_delivery.host_bootstrap import bootstrap_report, build_consumer
from baymax_delivery.host_custody import CustodyError, HostCustody
from baymax_delivery.runtime_bridge import Binding, ENDPOINT


def write_key(path, key, mode=0o600):
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    os.chmod(path, mode)
    return path


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.directory = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='baymax-bootstrap-')
        self.root = Path(self.directory.name)
        self.state = self.root / 'state.sqlite'
        import sqlite3
        with sqlite3.connect(self.state) as db:
            db.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT)')
        self.binding = Binding('42', '11111111-1111-4111-8111-111111111111', 'plankton:bootstrap-unit', '7',
                               'unit-bootstrap-run', int(time.time()) + 180)

    def tearDown(self):
        self.directory.cleanup()

    def custody(self):
        return HostCustody.load(write_key(self.root / 'host.pem', self.key), issuer='unit-bootstrap-issuer',
                                binding=self.binding)

    def test_bootstrap_report_publishes_public_configuration_only(self):
        custody = self.custody()
        try:
            report = bootstrap_report(custody, self.binding)
            self.assertEqual(report['BAYMAX_AGENT_AUDIENCE'], ENDPOINT)
            self.assertEqual(report['BAYMAX_AGENT_ISSUER'], 'unit-bootstrap-issuer')
            self.assertTrue(report['BAYMAX_AGENT_PUBLIC_KEY'].startswith('-----BEGIN PUBLIC KEY-----'))
            serialized = repr(report)
            self.assertNotIn('PRIVATE KEY', serialized)
            self.assertIn('same_uid_process_isolation', report['custody_statement']['not_enforced'])
        finally:
            custody.close()

    def test_bootstrap_refuses_a_raw_key_or_plain_object(self):
        with self.assertRaises(CustodyError):
            bootstrap_report(self.key, self.binding)
        with self.assertRaises(CustodyError):
            build_consumer(custody=self.key, binding=self.binding, state_path=self.state,
                           intent_path=self.root / 'intents.sqlite', session_id='unit-session',
                           outbox_path=self.root / 'outbox.sqlite', register=False)

    def test_closed_custody_cannot_enable_writeback(self):
        custody = self.custody()
        custody.close()
        with self.assertRaises(CustodyError):
            build_consumer(custody=custody, binding=self.binding, state_path=self.state,
                           intent_path=self.root / 'intents.sqlite', session_id='unit-session',
                           outbox_path=self.root / 'outbox.sqlite', register=False)

    def test_consumer_starts_without_touching_the_network(self):
        custody = self.custody()
        try:
            consumer, transport, outbox = build_consumer(
                custody=custody, binding=self.binding, state_path=self.state,
                intent_path=self.root / 'intents.sqlite', session_id='unit-session',
                outbox_path=self.root / 'outbox.sqlite', register=False)
            try:
                self.assertEqual(transport.issuer.binding.execution_ref, 'unit-bootstrap-run')
                started = consumer.handle('agent:start', {'session_id': 'unit-session', 'execution_ref': 'unit-bootstrap-run',
                                                          'expected_current_delivery_id': ''})
                self.assertEqual(started['status'], 'started')
                self.assertTrue(started['predecessorCaptured'])
                self.assertEqual(consumer.handle('agent:end', {'session_id': 'unit-session', 'execution_ref': 'unit-bootstrap-run'}),
                                 {'status': 'awaiting_persisted_terminal'})
            finally:
                outbox.close()
        finally:
            custody.close()


if __name__ == '__main__':
    unittest.main()
