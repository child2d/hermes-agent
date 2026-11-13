"""Trusted-host entry points, NOT agent tools or a public signing API.

Binding and key custody must be supplied by the runtime authority. A Python object
is not proof of that authority. No production key or binding is bundled here.
"""
import base64
import hashlib
import json
import re
import time
import ssl
import certifi
from dataclasses import dataclass
from uuid import UUID, uuid4
from urllib.request import Request, build_opener, HTTPRedirectHandler, HTTPSHandler
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import hashes
from .delivery_errors import DeliveryCancelled, DeliveryRevoked

ENDPOINT = 'https://baymax-bff-sandbox.shaoke.com/graphql'

def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()

def _normalised(value):
    """Canonical comparison form: absent and None are the same absence, lists keep order."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return [None if item is None else item for item in value]
    return value

def _b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()

@dataclass(frozen=True)
class Binding:
    issue_id: str
    grant_id: str
    subject: str
    delegator_id: str
    execution_ref: str
    deadline: int

class RuntimeIssuer:
    def __init__(self, key, binding, issuer):
        self._key, self.binding, self.issuer = key, binding, issuer

    def require_binding(self):
        b = self.binding
        if b is None or not re.fullmatch(r'[1-9][0-9]*', b.issue_id) or not re.fullmatch(r'[1-9][0-9]*', b.delegator_id):
            raise ValueError('Verified runtime binding required; live entry disabled')
        UUID(b.grant_id)
        if not b.subject.startswith('plankton:') or not b.execution_ref.strip() or not self.issuer:
            raise ValueError('Pinned runtime identity required')
        if b.deadline <= int(time.time()):
            raise ValueError('Runtime binding expired')
        return b

    def issue(self, operation):
        b = self.require_binding()
        if operation not in ('read', 'evidence', 'submit'):
            raise ValueError('Operation outside runtime authority')
        now = int(time.time())
        claims = dict(iss=self.issuer, aud=ENDPOINT, actor_type='agent', sub=b.subject,
                      delegator_id=b.delegator_id, issue_id=b.issue_id, grant_id=b.grant_id,
                      execution_ref=b.execution_ref, operations=[operation], jti=str(uuid4()),
                      iat=now, exp=min(now + 120, b.deadline))
        message = (_b64(_json({'alg': 'RS256', 'typ': 'JWT'})) + '.' + _b64(_json(claims))).encode()
        signature = self._key.sign(message, padding.PKCS1v15(), hashes.SHA256())
        return message.decode() + '.' + _b64(signature)

class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class SandboxTransport:
    def __init__(self, issuer, opener=None):
        self.issuer = issuer
        # Injection exists for explicit network-boundary tests, never a configured URL override.
        self._open = opener or _https_opener().open

    def _scope(self, endpoint, issue_id):
        binding = self.issuer.require_binding()
        if endpoint != ENDPOINT or issue_id != binding.issue_id:
            raise ValueError('Writeback target differs from verified sandbox binding')
        return binding

    def _request(self, query, variables, field, operation, require_id=True):
        token = self.issuer.issue(operation)
        request = Request(ENDPOINT, _json({'query': query, 'variables': variables}),
                          {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}, method='POST')
        try:
            with self._open(request, timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError('Writeback HTTP response rejected')
                body = response.read(1048577)
            if len(body) > 1048576:
                raise RuntimeError('Writeback response too large')
            result = json.loads(body)
        except Exception:
            # Never expose request headers, bearer assertions or raw remote error bodies.
            raise RuntimeError('Writeback not confirmed; resume same outbox key') from None
        if result.get('errors'):
            messages = ' '.join(str((e or {}).get('message', '')) for e in result['errors'])
            if 'cancelled' in messages.lower():
                raise DeliveryCancelled('This execution was cancelled; do not resubmit it')
            if any(word in messages.lower() for word in ('revoked', 'expired', 'scope mismatch', 'scope denied', 'forbidden')):
                raise DeliveryRevoked('Runtime authorization no longer valid')
            raise RuntimeError('GraphQL writeback rejected; retain outbox for reconciliation')
        receipt = result.get('data', {}).get(field)
        if not isinstance(receipt, dict):
            raise RuntimeError('Writeback acknowledgement absent')
        if require_id:
            if not isinstance(receipt.get('id'), str):
                raise RuntimeError('Writeback acknowledgement absent')
            UUID(receipt['id'])
        return receipt

    def register_evidence(self, *, endpoint, issue_id, name, content, request_key):
        binding = self._scope(endpoint, issue_id)
        query = '''mutation RegisterRuntimeEvidence($issueId:String!,$name:String!,$content:String!,$grantId:String!,$requestKey:String!){registerIssueDeliveryEvidence(issueId:$issueId,name:$name,content:$content,grantId:$grantId,requestKey:$requestKey)}'''
        receipt = self._request(query, dict(issueId=issue_id, name=name, content=content,
                                           grantId=binding.grant_id, requestKey=request_key), 'registerIssueDeliveryEvidence', 'evidence')
        if receipt.get('sha256') != hashlib.sha256(content.encode()).hexdigest() or receipt.get('name') != name:
            raise RuntimeError('Evidence receipt content mismatch')
        return receipt

    def read_receipt(self, *, endpoint, issue_id, operation, request_key, expected=None):
        """Server truth for one request key, validated like a normal receipt before it is adopted."""
        binding = self._scope(endpoint, issue_id)
        query = 'query RuntimeDeliveryReceipt($issueId:String!,$operation:String!,$requestKey:String!,$grantId:String!){issueDeliveryReceipt(issueId:$issueId,operation:$operation,requestKey:$requestKey,grantId:$grantId)}'
        result = self._request(query, dict(issueId=issue_id, operation=operation, requestKey=request_key,
                                           grantId=binding.grant_id), 'issueDeliveryReceipt', 'read', require_id=False)
        if result.get('issueId') != issue_id or result.get('requestKey') != request_key:
            raise RuntimeError('Receipt readback returned a different request')
        found = result.get('found')
        # Only an explicit boolean is a protocol answer. Missing/null/typed values are protocol
        # errors: keep pending instead of treating them as "no receipt" and rewriting.
        if not isinstance(found, bool):
            raise RuntimeError('Receipt answer is not a boolean found flag; keep pending')
        if found is False:
            return None
        receipt = result.get('receipt') or {}
        response = receipt.get('response')
        payload = receipt.get('payload') or {}
        if receipt.get('operation') != operation:
            raise RuntimeError('Receipt operation mismatch; keep pending')
        if receipt.get('subject') != binding.subject:
            raise RuntimeError('Receipt belongs to another subject; keep pending')
        if receipt.get('request_key') != request_key:
            raise RuntimeError('Receipt key mismatch; keep pending')
        if payload.get('executionRef') != binding.execution_ref:
            raise RuntimeError('Receipt was produced by another execution; keep pending')
        if not isinstance(response, dict) or not isinstance(response.get('id'), str):
            raise RuntimeError('Receipt readback payload unusable')
        UUID(response['id'])
        expected = expected or {}
        if operation == 'submit':
            if response.get('execution_ref') != binding.execution_ref:
                raise RuntimeError('Delivery receipt belongs to another execution; keep pending')
            # Compare the whole client payload, not just run+version: a receipt for a different
            # summary / evidence set / unfinished list / outcome / predecessor must not clear pending.
            for key, want in expected.items():
                if key in ('sha256', 'name'):
                    continue
                got = payload.get(key)
                if _normalised(got) != _normalised(want):
                    raise RuntimeError(f'Delivery receipt payload mismatch on {key}; keep pending')
            if expected.get('version') is not None and response.get('version') != expected['version']:
                raise RuntimeError('Delivery receipt version mismatch; keep pending')
        if operation == 'evidence':
            if expected.get('sha256') is not None and response.get('sha256') != expected['sha256']:
                raise RuntimeError('Evidence receipt content mismatch; keep pending')
            if expected.get('name') is not None and response.get('name') != expected['name']:
                raise RuntimeError('Evidence receipt name mismatch; keep pending')
        return response

    def read_state(self, *, endpoint, issue_id):
        binding = self._scope(endpoint, issue_id)
        query = 'query RuntimeDeliveryReadback($issueId:String!,$grantId:String!){issueDeliveryState(issueId:$issueId,grantId:$grantId)}'
        state = self._request(query, {'issueId': issue_id, 'grantId': binding.grant_id}, 'issueDeliveryState', 'read', require_id=False)
        if state.get('issueId') != issue_id:
            raise ValueError('Readback returned a different issue')
        return state

    def submit_delivery(self, *, endpoint, issue_id, execution_ref, version, summary, unfinished, evidence_ids, request_key, outcome=None,
                        expected_current_delivery_id=None):
        binding = self._scope(endpoint, issue_id)
        if execution_ref != binding.execution_ref:
            raise ValueError('Cannot publish a different runtime execution')
        if expected_current_delivery_id is None:
            raise ValueError('Predecessor must be fixed at prepare time: send "" when there is no current delivery')
        query = 'mutation SubmitRuntimeDelivery($input:SubmitIssueDeliveryInput!){submitIssueDelivery(input:$input)}'
        payload = dict(issueId=issue_id, grantId=binding.grant_id, executionRef=execution_ref,
                       version=version, summary=summary, unfinished=unfinished,
                       evidenceIds=evidence_ids, requestKey=request_key,
                       expectedCurrentDeliveryId=expected_current_delivery_id)
        if outcome is not None:
            payload['outcome'] = outcome
        receipt = self._request(query, {'input': payload}, 'submitIssueDelivery', 'submit')
        if receipt.get('version') != version:
            raise RuntimeError('Delivery receipt version mismatch')
        return receipt


def _https_opener():
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return build_opener(_NoRedirect(), HTTPSHandler(context=context))


def probe_public_transport():
    """Unauthenticated, read-only real-network probe. Never mints an assertion."""
    request = Request(ENDPOINT, _json({'query': '{__typename}'}), {'Content-Type': 'application/json'}, method='POST')
    with _https_opener().open(request, timeout=15) as response:
        result = json.loads(response.read(1048576))
        return {'endpoint': ENDPOINT, 'http_status': response.status,
                'query_type': result.get('data', {}).get('__typename'), 'authenticated': False, 'mutation': False}
