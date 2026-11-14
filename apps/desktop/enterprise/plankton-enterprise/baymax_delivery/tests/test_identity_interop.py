import _path_setup
EXTERNAL_BFF_REASON = _path_setup.EXTERNAL_BFF_REASON
"""Cross-language compatibility against the actual built BFF verifier, NOT live trust."""
import json
import os
import subprocess
import time
import unittest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from baymax_delivery.runtime_bridge import RuntimeIssuer, Binding, ENDPOINT

class IdentityInteropTests(unittest.TestCase):
    def test_python_runtime_signature_is_accepted_by_real_compiled_bff_verifier(self):
        module = os.environ.get('BAYMAX_BFF_DIST_MODULE')
        if not module:
            self.skipTest(EXTERNAL_BFF_REASON)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        binding = Binding('42','11111111-1111-4111-8111-111111111111','plankton:isolated-interop','7','unit-interop-run',int(time.time())+180)
        token = RuntimeIssuer(key,binding,'isolated-interop-issuer').issue('submit')
        payload = {'token':token,'key':key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
                   'issuer':'isolated-interop-issuer','audience':ENDPOINT}
        code = '''const {verifyWorkloadIdentity}=require(process.argv[1]);let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const p=JSON.parse(input);const actor=verifyWorkloadIdentity(p.token,{BAYMAX_AGENT_PUBLIC_KEY:p.key,BAYMAX_AGENT_ISSUER:p.issuer,BAYMAX_AGENT_AUDIENCE:p.audience});console.log(JSON.stringify({kind:actor.kind,subject:actor.subject,issueId:actor.issueId,executionRef:actor.executionRef,operations:actor.operations}));});'''
        result = subprocess.run(['node','-e',code,module],input=json.dumps(payload),text=True,capture_output=True,timeout=15,check=False)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout), {'kind':'agent','subject':'plankton:isolated-interop','issueId':'42','executionRef':'unit-interop-run','operations':['submit']})

if __name__ == '__main__': unittest.main()
