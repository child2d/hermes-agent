import _path_setup
EXTERNAL_BFF_REASON = _path_setup.EXTERNAL_BFF_REASON
"""Custody preconditions are enforced locally; the remote verifier check uses the real build."""
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from baymax_delivery.host_custody import CustodyError, HostCustody
from baymax_delivery.runtime_bridge import Binding, ENDPOINT


def write_key(path, key, mode=0o600):
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    path.write_bytes(pem)
    os.chmod(path, mode)
    return path


BINDING = Binding('42', '11111111-1111-4111-8111-111111111111', 'plankton:custody-unit', '7', 'unit-custody-run',
                  int(time.time()) + 180)


class CustodyTests(unittest.TestCase):
    def setUp(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.directory = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='baymax-custody-')

    def tearDown(self):
        self.directory.cleanup()

    def test_valid_host_key_exposes_only_a_public_fingerprint(self):
        path = write_key(Path(self.directory.name) / 'host.pem', self.key)
        custody = HostCustody.load(path, issuer='unit-custody-issuer', binding=BINDING)
        try:
            self.assertTrue(custody.fingerprint().startswith('sha256:'))
            self.assertIn('open', repr(custody))
            self.assertNotIn('PRIVATE KEY', repr(custody))
            self.assertNotIn('PRIVATE KEY', str(custody))
            statement = custody.statement()
            self.assertEqual(statement['audience'], ENDPOINT)
            self.assertLessEqual(statement['max_assertion_seconds'], 120)
            self.assertIn('same_uid_process_isolation', statement['not_enforced'])
            self.assertIn('outside_agent_workspace', statement['enforced'])
        finally:
            custody.close()

    def test_refuses_world_readable_key(self):
        path = write_key(Path(self.directory.name) / 'loose.pem', self.key, mode=0o644)
        with self.assertRaises(CustodyError) as caught:
            HostCustody.load(path, issuer='unit', binding=BINDING)
        self.assertIn('group or others', str(caught.exception))
        self.assertNotIn('PRIVATE KEY', str(caught.exception))

    def test_refuses_symlinked_key(self):
        real = write_key(Path(self.directory.name) / 'real.pem', self.key)
        link = Path(self.directory.name) / 'link.pem'
        link.symlink_to(real)
        with self.assertRaises(CustodyError):
            HostCustody.load(link, issuer='unit', binding=BINDING)

    def test_refuses_key_inside_the_agent_workspace(self):
        beside = Path(__file__).resolve().parent / 'unit-must-not-exist.pem'
        write_key(beside, self.key)
        try:
            with self.assertRaises(CustodyError) as caught:
                HostCustody.load(beside, issuer='unit', binding=BINDING)
            self.assertIn('agent-facing workspace', str(caught.exception))
        finally:
            beside.unlink(missing_ok=True)

    def test_minted_assertion_is_short_lived_and_bound_to_one_run(self):
        path = write_key(Path(self.directory.name) / 'host.pem', self.key)
        custody = HostCustody.load(path, issuer='unit-custody-issuer', binding=BINDING)
        try:
            token = custody.mint('submit')
            header, claims, signature = token.split('.')
            import base64
            padded = lambda part: part + '=' * (-len(part) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded(claims)))
            self.assertEqual(payload['aud'], ENDPOINT)
            self.assertEqual(payload['issue_id'], '42')
            self.assertEqual(payload['execution_ref'], 'unit-custody-run')
            self.assertEqual(payload['operations'], ['submit'])
            self.assertLessEqual(payload['exp'] - payload['iat'], 120)
            self.key.public_key().verify(base64.urlsafe_b64decode(padded(signature)),
                                         (header + '.' + claims).encode(), padding.PKCS1v15(), hashes.SHA256())
        finally:
            custody.close()

    def test_closed_custody_refuses_to_sign(self):
        path = write_key(Path(self.directory.name) / 'host.pem', self.key)
        custody = HostCustody.load(path, issuer='unit', binding=BINDING)
        custody.close()
        with self.assertRaises(CustodyError):
            custody.mint('submit')
        self.assertIn('closed', repr(custody))

    def test_real_compiled_bff_verifier_accepts_the_custody_assertion(self):
        module = os.environ.get('BAYMAX_BFF_DIST_MODULE')
        if not module:
            self.skipTest(EXTERNAL_BFF_REASON)
        path = write_key(Path(self.directory.name) / 'host.pem', self.key)
        custody = HostCustody.load(path, issuer='unit-custody-issuer', binding=BINDING)
        try:
            token = custody.mint('evidence')
            payload = {'token': token, 'key': custody.public_key_pem(), 'issuer': 'unit-custody-issuer', 'audience': ENDPOINT}
        finally:
            custody.close()
        code = ('const {verifyWorkloadIdentity}=require(process.argv[1]);let input="";'
                'process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>{const p=JSON.parse(input);'
                'const actor=verifyWorkloadIdentity(p.token,{BAYMAX_AGENT_PUBLIC_KEY:p.key,'
                'BAYMAX_AGENT_ISSUER:p.issuer,BAYMAX_AGENT_AUDIENCE:p.audience});'
                'console.log(JSON.stringify({kind:actor.kind,subject:actor.subject,operations:actor.operations}));});')
        result = subprocess.run(['node', '-e', code, module], input=json.dumps(payload), text=True,
                                capture_output=True, timeout=15, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout),
                         {'kind': 'agent', 'subject': 'plankton:custody-unit', 'operations': ['evidence']})


if __name__ == '__main__':
    unittest.main()
