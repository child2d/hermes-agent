import _path_setup  # noqa: F401  (puts the plugin directory on sys.path)
"""Actual HTTP/socket + SQLite probe test; REMOTE SERVER IS AN EXPLICIT FIXTURE."""
import hashlib
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from cryptography.hazmat.primitives.asymmetric import rsa
from baymax_delivery.ack_loss_probe import run_ack_loss_probe
from baymax_delivery.delivery_outbox import DeliveryOutbox
from baymax_delivery.runtime_bridge import Binding, RuntimeIssuer, SandboxTransport, ENDPOINT

class AckLossTests(unittest.TestCase):
    def test_both_successful_remote_writes_lose_receipts_then_restore_one_version(self):
        evidence, deliveries, submitted, request_count = {}, {}, {}, []
        class Fixture(BaseHTTPRequestHandler):
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length']))); variables=body['variables']; query=body['query']
                request_count.append(query)
                if 'registerIssueDeliveryEvidence' in query:
                    evidence.setdefault(variables['requestKey'],{'id':'22222222-2222-4222-8222-222222222222','name':variables['name'],'sha256':hashlib.sha256(variables['content'].encode()).hexdigest()})
                    reply={'registerIssueDeliveryEvidence':evidence[variables['requestKey']]}
                elif 'issueDeliveryReceipt' in query:
                    # Authenticated server truth for the same request key (ack was lost, write committed).
                    key=variables['requestKey']
                    stored = evidence.get(key) or deliveries.get(key)
                    # Mirror the real BFF: receipt.payload is the submitted input, keyed exactly like it.
                    payload = submitted.get(key) or ({'issueId':'42','executionRef':'unit-loss-run'} if stored else {})
                    reply={'issueDeliveryReceipt':{'issueId':variables['issueId'],'operation':variables['operation'],
                        'requestKey':key,'found':bool(stored),
                        'receipt':{'subject':'plankton:isolated-loss-probe','operation':variables['operation'],
                                   'request_key':key,'payload':payload,'response':stored} if stored else None}}
                elif 'submitIssueDelivery' in query:
                    item=variables['input']
                    submitted[item['requestKey']]=item
                    deliveries.setdefault(item['requestKey'],{'id':'33333333-3333-4333-8333-333333333333','version':item['version'],'execution_ref':item['executionRef'],'evidence_ids':item['evidenceIds']})
                    reply={'submitIssueDelivery':deliveries[item['requestKey']]}
                else:
                    reply={'issueDeliveryState':{'issueId':'42','evidence':list(evidence.values()),'history':{'deliveries':list(deliveries.values())}}}
                data=json.dumps({'data':reply}).encode(); self.send_response(200); self.end_headers(); self.wfile.write(data)
            def log_message(self,*args): pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Fixture); thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def loopback(request, timeout):
            self.assertEqual(request.full_url,ENDPOINT)
            return urlopen(Request(f'http://127.0.0.1:{server.server_port}/graphql',request.data,dict(request.headers)),timeout=timeout)
        signing_key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        binding=Binding('42','11111111-1111-4111-8111-111111111111','plankton:isolated-loss-probe','7','unit-loss-run',int(time.time())+180)
        transport=SandboxTransport(RuntimeIssuer(signing_key,binding,'unit-loss-issuer'),opener=loopback)
        try:
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'outbox.sqlite'; outbox=DeliveryOutbox(path)
                key=outbox.enqueue(endpoint=ENDPOINT,issue_id='42',execution_ref='unit-loss-run',version='unit-loss-v1',summary='Explicit test output, not a formal run',unfinished=None,artifacts=[{'name':'unit.txt','content':'Unit evidence'}],expected_current_delivery_id='');outbox.close()
                report=run_ack_loss_probe(path,key,transport)
                self.assertEqual(report['lost_ack_points'],['evidence','delivery'])
                self.assertEqual(report['delivery_id'],'33333333-3333-4333-8333-333333333333')
                self.assertEqual(report['version'],'unit-loss-v1')
                self.assertEqual(report['evidence_ids'],['22222222-2222-4222-8222-222222222222'])
                self.assertEqual(len(evidence),1);self.assertEqual(len(deliveries),1)
                self.assertEqual(sum('registerIssueDeliveryEvidence' in q for q in request_count),1)
                self.assertEqual(sum('submitIssueDelivery' in q for q in request_count),1)
                self.assertEqual([o['outcome'] for o in report['ack_loss_outcomes']],['pending_same_key','reconciled_from_server'])
                self.assertFalse(report['business_execution_verified'])
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_unbound_probe_cannot_touch_network_or_open_a_missing_queue(self):
        transport=SandboxTransport(RuntimeIssuer(None,None,'unconfigured'),opener=lambda *a,**kw:self.fail('Must not send'))
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'must-not-create.sqlite'
            with self.assertRaises(ValueError):run_ack_loss_probe(path,'unknown',transport)
            self.assertFalse(path.exists())

if __name__=='__main__':unittest.main()
