"""Real turn entry: admission gate -> model call -> artifact -> canonical terminal -> delivery.

This is the one-shot entry a host may run. The order is deliberate:

  1. ``StartAdmission`` decides whether this ``(issue, execution)`` may run at all. A repeat,
     a concurrent duplicate, a retry after completion and a recovery attempt all stop here —
     before the model is called, before an artifact is written, before a message is appended.
     A run whose outcome is unknown is **not** re-executed.
  2. the delivery predecessor is captured from BFF state *before* the run starts, so a retry can
     never adopt a newer head;
  3. the consumer records the admission intent; ``handle`` returning ``None`` (session mismatch)
     aborts the turn instead of continuing;
  4. the model is called over HTTP(S). The **default** transport requires HTTPS, refuses redirects
     and refuses a response from another origin, so the bearer cannot be sent to a different host.
     An injected transport is trusted code and owns its own redirect policy; the client can only
     refuse the resulting response, not un-send the request;
  5. the business artifact is written; the authoritative terminal is appended through the
     repository's real canonical transcript API (not hand-written SQL);
  6. the consumer classifies the persisted row *by id* and writes the delivery back.

Everything is dependency-injected: ``store`` is a real ``SessionDB`` in production and in tests,
and ``model`` may carry an explicit test transport. Nothing here starts a scheduler.

Scope note: this entry is the *code path* a host would run. It does not by itself make a host
production-ready — the isolation/custody boundary is still unimplemented (see ``host_runner``), and
no real model or sandbox delivery has been executed through it.
"""

import json
import os
import sqlite3
import urllib.parse
import urllib.request
from pathlib import Path

from .start_admission import StartAdmission


class ModelUnavailable(RuntimeError):
    pass


class TurnRejected(RuntimeError):
    """The turn must not run; carries a machine-readable reason and whether anything ran."""

    def __init__(self, reason, **details):
        super().__init__(reason)
        self.reason = reason
        self.details = details


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is a refusal, not a hop: the Authorization header must never follow one."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _origin(url):
    parts = urllib.parse.urlsplit(url)
    return (parts.scheme, parts.hostname, parts.port)


class OpenAICompatibleModel:
    """Minimal chat-completions client with an explicit transport policy.

    Production defaults: HTTPS only, redirects refused, and the response must come from the same
    origin as the configured endpoint. A plaintext endpoint or a custom transport is only accepted
    when the caller says so explicitly (loopback tests do), so the production default never relaxes.
    """

    def __init__(self, endpoint, model, api_key_env='BAYMAX_MODEL_API_KEY', timeout=60, opener=None,
                 allow_plaintext_endpoint=False):
        if not endpoint or not model:
            raise ValueError('model endpoint and model name are required')
        self.endpoint = endpoint.rstrip('/')
        self.model = model
        self.api_key_env = api_key_env
        self.timeout = timeout
        scheme = urllib.parse.urlsplit(self.endpoint).scheme
        if scheme != 'https' and not allow_plaintext_endpoint:
            raise ValueError('model endpoint must be https (plaintext only for an explicit test transport)')
        self._allow_plaintext = allow_plaintext_endpoint
        self._opener = opener or self._default_opener
        self.calls = 0

    def _default_opener(self, request, timeout):
        opener = urllib.request.build_opener(_NoRedirect)
        return opener.open(request, timeout=timeout)

    def complete(self, prompt):
        api_key = os.environ.get(self.api_key_env, '')
        if not api_key:
            raise ModelUnavailable(f'model credential is not provisioned ({self.api_key_env})')
        payload = json.dumps({'model': self.model, 'messages': [{'role': 'user', 'content': prompt}],
                              'temperature': 0}).encode()
        url = self.endpoint + '/chat/completions'
        request = urllib.request.Request(url, payload,
                                         {'content-type': 'application/json',
                                          'authorization': 'Bearer ' + api_key})
        self.calls += 1
        try:
            with self._opener(request, self.timeout) as response:
                final = response.geturl() if hasattr(response, 'geturl') else url
                if _origin(final) != _origin(self.endpoint):
                    # A transport that followed a redirect has already leaked the bearer; refuse the
                    # result and never parse it as a completion.
                    raise ModelUnavailable('model response came from another origin; refusing the turn')
                body = json.loads(response.read(1 << 20))
        except ModelUnavailable:
            raise
        except (OSError, ValueError, RuntimeError) as error:
            raise ModelUnavailable(f'model call failed: {type(error).__name__}') from None
        choices = body.get('choices') or []
        if not choices:
            raise ModelUnavailable('model returned no choice')
        text = (choices[0].get('message') or {}).get('content')
        if not isinstance(text, str) or not text.strip():
            raise ModelUnavailable('model returned empty content')
        return text, body.get('usage') or {}


def capture_predecessor(transport, issue_id, endpoint):
    """Host-side read: the delivery that exists *now* is what this run replaces."""
    state = transport.read_state(endpoint=endpoint, issue_id=issue_id)
    head = state.get('expectedCurrentDeliveryId')
    if head is None:
        head = ''
    if not isinstance(head, str):
        raise ValueError('state returned a non-string predecessor')
    return head


def _endpoint_of(transport):
    from .runtime_bridge import ENDPOINT
    return ENDPOINT


def persist_terminal(store, session_id, content, kind=None, timestamp=None):
    """Append the authoritative assistant terminal through the real canonical API.

    ``store`` is the repository's ``SessionDB`` (or its async facade's underlying object). The
    write keeps every column the real schema requires (``timestamp`` is NOT NULL with no default)
    and goes through the store's own guards and counters, so a real state.db accepts it.
    """
    return store.append_message(session_id, 'assistant', content, display_kind=kind, timestamp=timestamp)


def write_artifact(directory, execution_ref, text, usage):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"turn-{execution_ref.replace(':', '-')}.json"
    path.write_text(json.dumps({'executionRef': execution_ref, 'output': text, 'usage': usage},
                               ensure_ascii=False, indent=2))
    return path


def _admission_key(issue_id, execution_ref):
    return f'{issue_id}:{execution_ref}'


def run_turn(*, transport, consumer, model, store, session_id, execution_ref, issue_id, prompt,
             artifacts_dir, admission_path, goal_version=None, endpoint=None):
    """Run at most once per ``(issue, execution)`` and deliver the persisted terminal."""
    admission = StartAdmission(admission_path)
    try:
        ticket = admission.admit(request_key=_admission_key(issue_id, execution_ref),
                                 issue_id=str(issue_id), execution_ref=execution_ref,
                                 goal_version=goal_version)
        if not ticket['shouldLaunch']:
            # Repeat click, concurrent duplicate, retry after completion, or an unknown outcome:
            # the business side already ran (or is running) and must not run again here.
            return {'status': 'blocked_already_started', 'reason': ticket['state'],
                    'execution_ref': execution_ref, 'modelCalls': 0, 'delivery': None}
        predecessor = capture_predecessor(transport, issue_id, endpoint or _endpoint_of(transport))
        admitted = consumer.handle('agent:start', {
            'session_id': session_id, 'execution_ref': execution_ref,
            'expected_current_delivery_id': predecessor})
        if admitted is None:
            admission.abandon(_admission_key(issue_id, execution_ref), note='consumer refused admission')
            return {'status': 'blocked_consumer_refused', 'execution_ref': execution_ref,
                    'modelCalls': 0, 'delivery': None}
        if admitted.get('status') != 'started':
            admission.abandon(_admission_key(issue_id, execution_ref), note='duplicate admission intent')
            return {'status': 'blocked_duplicate_intent', 'reason': admitted.get('status'),
                    'execution_ref': execution_ref, 'modelCalls': 0, 'delivery': None}
        try:
            text, usage = model.complete(prompt)
        except ModelUnavailable:
            admission.abandon(_admission_key(issue_id, execution_ref), note='model unavailable')
            raise
        artifact = write_artifact(artifacts_dir, execution_ref, text, usage)
        try:
            message_id = persist_terminal(store, session_id, text)
        except (OSError, RuntimeError, ValueError, sqlite3.Error):
            # No persisted terminal means nothing to deliver: keep the run pending instead of
            # emitting a ready event or inventing an id.
            admission.abandon(_admission_key(issue_id, execution_ref), note='terminal persist failed')
            raise
        ready = consumer.handle('agent:delivery-ready', {
            'session_id': session_id, 'execution_ref': execution_ref,
            'canonical_message_id': message_id, 'terminal_run': execution_ref,
            'terminal_source': 'append_return', 'response': text, 'outcome': 'completed'})
        delivery = consumer.resume(execution_ref)
        admission.finish(_admission_key(issue_id, execution_ref), note='terminal persisted')
        return {'status': 'completed', 'predecessor': predecessor, 'admitted': admitted,
                'terminalMessageId': message_id, 'artifact': str(artifact), 'ready': ready,
                'delivery': delivery, 'modelCalls': getattr(model, 'calls', None)}
    finally:
        admission.close()
