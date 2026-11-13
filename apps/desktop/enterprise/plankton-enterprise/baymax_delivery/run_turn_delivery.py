"""Real turn entry: model call -> business artifact -> authoritative terminal -> delivery.

This is the wiring that turns the completion consumer from "a hook someone could call" into the
actual production path:

  1. the host captures the delivery predecessor from BFF state *before* the run starts (read
     assertion, host-held key), so a retry can never adopt a newer head;
  2. admission stores that predecessor once;
  3. the model is called over HTTP (no key material is logged, ever);
  4. the business artifact is written and kept;
  5. the authoritative terminal is appended to the canonical transcript;
  6. the completion consumer classifies that terminal and writes the delivery back.

Everything is dependency-injected so the same code runs with the isolated signer (in-cluster) or a
test transport.
"""

import json
import os
import sqlite3
import time
import urllib.request
from contextlib import closing
from pathlib import Path


class ModelUnavailable(RuntimeError):
    pass


class OpenAICompatibleModel:
    """Minimal chat-completions client. The API key is read from env at call time and never logged."""

    def __init__(self, endpoint, model, api_key_env='BAYMAX_MODEL_API_KEY', timeout=60, opener=None):
        if not endpoint or not model:
            raise ValueError('model endpoint and model name are required')
        self.endpoint = endpoint.rstrip('/')
        self.model = model
        self.api_key_env = api_key_env
        self.timeout = timeout
        self._opener = opener or (lambda request, timeout: urllib.request.urlopen(request, timeout=timeout))
        self.calls = 0

    def complete(self, prompt):
        api_key = os.environ.get(self.api_key_env, '')
        if not api_key:
            raise ModelUnavailable(f'model credential is not provisioned ({self.api_key_env})')
        payload = json.dumps({'model': self.model, 'messages': [{'role': 'user', 'content': prompt}],
                              'temperature': 0}).encode()
        request = urllib.request.Request(self.endpoint + '/chat/completions', payload,
                                         {'content-type': 'application/json',
                                          'authorization': 'Bearer ' + api_key})
        self.calls += 1
        try:
            with self._opener(request, self.timeout) as response:
                body = json.loads(response.read(1 << 20))
        except Exception as error:
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


def persist_terminal(state_path, session_id, content, kind=None):
    """Append the authoritative assistant terminal; returns its message id."""
    with closing(sqlite3.connect(state_path)) as db, db:
        cursor = db.execute('INSERT INTO messages(session_id,role,content,display_kind) VALUES(?,?,?,?)',
                            (session_id, 'assistant', content, kind))
        return cursor.lastrowid


def write_artifact(directory, execution_ref, text, usage):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"turn-{execution_ref.replace(':', '-')}.json"
    path.write_text(json.dumps({'executionRef': execution_ref, 'output': text, 'usage': usage},
                               ensure_ascii=False, indent=2))
    return path


def run_turn(*, transport, consumer, model, state_path, session_id, execution_ref, issue_id, prompt,
             artifacts_dir, endpoint=None):
    """Execute one real turn and deliver it. Returns a summary dict (never secrets)."""
    predecessor = capture_predecessor(transport, issue_id, endpoint or _endpoint_of(transport))
    admitted = consumer.handle('agent:start', {'session_id': session_id, 'execution_ref': execution_ref,
                                              'expected_current_delivery_id': predecessor})
    text, usage = model.complete(prompt)
    artifact = write_artifact(artifacts_dir, execution_ref, text, usage)
    message_id = persist_terminal(state_path, session_id, text)
    ready = consumer.handle('agent:delivery-ready', {'session_id': session_id, 'execution_ref': execution_ref,
                                                    'response': text, 'outcome': 'completed'})
    delivery = consumer.resume(execution_ref)
    return {'predecessor': predecessor, 'admitted': admitted, 'terminalMessageId': message_id,
            'artifact': str(artifact), 'ready': ready, 'delivery': delivery}
