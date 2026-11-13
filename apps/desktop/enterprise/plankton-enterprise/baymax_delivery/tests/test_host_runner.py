import _path_setup
"""The standalone host refuses to run without a real OS boundary and never re-runs business work."""
import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from baymax_delivery import host_runner


def write_key(path, key, mode=0o600):
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    os.chmod(path, mode)
    return path


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='baymax-host-')
        self.root = Path(self.tmp.name)
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.key_path = write_key(self.root / 'host.pem', self.key)

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_uid_is_reported_as_no_os_boundary(self):
        report = host_runner.boundary_check(self.key_path, os.getuid())
        self.assertFalse(report['osBoundarySatisfied'])
        self.assertIn('agent_and_host_share_uid', report['reasons'])
        self.assertTrue(report['requires_new_privilege_for_full_isolation'])

    def test_different_agent_uid_is_only_a_declaration_until_verified(self):
        other_uid = os.getuid() + 4242
        report = host_runner.boundary_check(self.key_path, other_uid)
        # A declared uid difference is not evidence: no access-denied probe, no boundary.
        self.assertFalse(report['osBoundarySatisfied'])
        self.assertEqual(report['verdict'], 'declared_separation_unverified')
        self.assertEqual(report['verifiedBy'], 'declaration')
        self.assertIn('agent_separation_not_verified', report['reasons'])

    def _receipt(self, monkeypatch_env=None, **overrides):
        import time as _time
        env = monkeypatch_env or {}
        receipt = {
            'source': 'deploy-collector', 'podUid': 'pod-uid-1', 'container': 'agent',
            'uid': os.getuid() + 4242, 'mountPath': str(self.key_path.parent),
            'keyFingerprint': host_runner.key_fingerprint(str(self.key_path)),
            'configSha256': host_runner.config_fingerprint(env), 'collectedAt': int(_time.time()), 'readDenied': True,
        }
        receipt.update(overrides)
        return receipt

    def _deploy_dir(self, mode=0o755):
        directory = self.root / 'deploy'
        directory.mkdir(exist_ok=True)
        os.chmod(directory, mode)
        return directory

    def test_a_hand_written_receipt_never_verifies(self):
        directory = self._deploy_dir()
        path = directory / 'receipt.json'
        path.write_text(json.dumps(self._receipt(source='manual')))
        report = host_runner.boundary_check(self.key_path, os.getuid() + 4242,
                                            receipt=host_runner._read_receipt(str(path)), receipt_dir=str(directory))
        self.assertFalse(report['osBoundarySatisfied'])
        self.assertIn('receipt_not_from_deploy_collector', report['reasons'])

    def test_receipt_material_never_verifies_without_control_attestation(self):
        directory = self._deploy_dir()
        agent_uid = os.getuid() + 4242
        path = directory / 'receipt.json'
        path.write_text(json.dumps(self._receipt(uid=agent_uid)))
        report = host_runner.boundary_check(self.key_path, agent_uid,
                                            receipt=host_runner._read_receipt(str(path)), receipt_dir=str(directory))
        # "source":"deploy-collector" is a caller-typed string: structure alone cannot attest it.
        self.assertFalse(report['osBoundarySatisfied'])
        self.assertEqual(report['verdict'], 'receipt_material_unverified')
        self.assertIn('receipt_is_not_control_attested', report['reasons'])

    def test_receipt_must_be_fresh_bound_and_inside_the_deploy_dir(self):
        directory = self._deploy_dir()
        agent_uid = os.getuid() + 4242
        cases = {
            'receipt_uid_mismatch': {'uid': agent_uid + 1},
            'receipt_key_fingerprint_mismatch': {'keyFingerprint': 'sha256:deadbeef'},
            'receipt_config_mismatch': {'configSha256': 'sha256:other'},
            'receipt_mount_mismatch': {'mountPath': '/somewhere/else'},
            'receipt_stale': {'collectedAt': 1},
            'receipt_did_not_show_denial': {'readDenied': False},
        }
        for expected, override in cases.items():
            with self.subTest(case=expected):
                path = directory / (expected + '.json')
                base = self._receipt()
                base['uid'] = agent_uid
                base.update(override)
                path.write_text(json.dumps(base))
                report = host_runner.boundary_check(self.key_path, agent_uid,
                                                    receipt=host_runner._read_receipt(str(path)), receipt_dir=str(directory))
                self.assertFalse(report['osBoundarySatisfied'])
                self.assertIn(expected, report['reasons'])
        # Missing required fields, and a receipt outside the deploy dir, are refused too.
        incomplete = self._receipt(uid=agent_uid)
        incomplete.pop('podUid')
        self.assertFalse(host_runner.boundary_check(self.key_path, agent_uid, receipt=incomplete,
                                                    receipt_dir=str(directory))['osBoundarySatisfied'])
        outside = self.root / 'receipt.json'
        outside.write_text(json.dumps(self._receipt(uid=agent_uid)))
        report = host_runner.boundary_check(self.key_path, agent_uid,
                                            receipt=json.loads(outside.read_text()), receipt_dir=str(directory))
        self.assertIn('receipt_outside_deploy_dir', report['reasons'])

    def test_agent_writable_receipt_dir_is_refused(self):
        directory = self._deploy_dir(mode=0o777)
        agent_uid = os.getuid() + 4242
        path = directory / 'receipt.json'
        path.write_text(json.dumps(self._receipt(uid=agent_uid)))
        report = host_runner.boundary_check(self.key_path, agent_uid,
                                            receipt=host_runner._read_receipt(str(path)), receipt_dir=str(directory))
        self.assertFalse(report['osBoundarySatisfied'])
        self.assertIn('receipt_dir_group_or_other_writable', report['reasons'])

    def test_unknown_agent_identity_fails_closed(self):
        report = host_runner.boundary_check(self.key_path, None)
        self.assertFalse(report['osBoundarySatisfied'])
        self.assertEqual(report['verdict'], 'agent_identity_unknown')
        self.assertIn('agent_identity_unknown', report['reasons'])

    def test_group_readable_key_is_not_a_boundary(self):
        loose = write_key(self.root / 'loose.pem', self.key, mode=0o644)
        report = host_runner.boundary_check(loose, os.getuid() + 4242)
        self.assertFalse(report['osBoundarySatisfied'])
        self.assertIn('key_group_or_other_readable', report['reasons'])

    def test_check_mode_exits_nonzero_without_a_boundary(self):
        argv = ['--check', '--key', str(self.key_path), '--agent-uid', str(os.getuid())]
        out = io.StringIO()
        with redirect_stdout(out):
            code = host_runner.main(argv)
        self.assertEqual(code, 2)
        report = json.loads(out.getvalue())
        self.assertFalse(report['osBoundarySatisfied'])
        self.assertTrue(str(report['keyFingerprint']).startswith('sha256:'))

    def test_run_mode_refuses_same_uid_before_touching_network(self):
        argv = ['--run', '--key', str(self.key_path), '--agent-uid', str(os.getuid()),
                '--issuer', 'unit', '--issue', '42', '--grant', '11111111-1111-4111-8111-111111111111',
                '--subject', 'plankton:unit', '--delegator', '7', '--execution-ref', 'run:1',
                '--deadline', str(int(time.time()) + 120), '--state', str(self.root / 'state.sqlite'),
                '--intents', str(self.root / 'intents.sqlite'), '--outbox', str(self.root / 'outbox.sqlite'),
                '--session', 'unit-session',
                '--boundary-receipt', str(self.root / 'absent.json'), '--receipt-dir', str(self.root)]
        err = io.StringIO()
        with redirect_stderr(err):
            code = host_runner.main(argv)
        self.assertEqual(code, 3)
        self.assertIn('blocked_no_verified_os_boundary', err.getvalue())

    def test_run_once_recovers_and_writes_back_without_business_work(self):
        calls = []
        class FakeConsumer:
            def unfinished_runs(self): return ['run:1', 'run:2']
            def recover_from_canonical(self, ref):
                calls.append(('recover', ref))
                return {'status': 'recovered_terminal' if ref == 'run:1' else 'no_terminal'}
            def resume(self, ref):
                calls.append(('resume', ref))
                return {'status': 'submitted'}
        results = host_runner.run_once(FakeConsumer(), transport=None)
        self.assertEqual(calls, [('recover', 'run:1'), ('resume', 'run:1'), ('recover', 'run:2')])
        self.assertEqual(results[0]['writeback'], 'submitted')
        self.assertEqual(results[1]['recovery'], 'no_terminal')
        self.assertNotIn('writeback', results[1])


if __name__ == '__main__':
    unittest.main()
