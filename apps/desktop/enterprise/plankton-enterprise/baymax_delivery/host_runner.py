"""Sandbox execution host **scaffold — not an enabled host**. Signing stays closed.

Status, stated precisely: this module implements the *checks* a host would need, but its
``--run`` path is permanently fail-closed in this PR — no receipt format can currently reach
``verified_os_boundary``, so a key is never used and no delivery is signed here. It is shipped as a
default-closed component, not as a working production host.

Why: OS isolation cannot be self-attested. A boundary receipt is only meaningful when a *controlled
deploy collector* produces it, bound to the pod UID, the container, the real agent uid, the exact
mount path, the key fingerprint and this deployment's configuration fingerprint, in a directory the
agent uid cannot write. A caller-written JSON in an agent-writable directory is treated as material
that needs verification, never as verification. Until such a collector exists, ``--run`` exits 3.

What is *not* claimed: no production execution path is verified, no real model/host run has
happened, and this file must not be presented as "the host is done".
"""
import argparse
import hashlib
import json
import os
import sqlite3
import stat
import sys
from pathlib import Path

from cryptography.exceptions import UnsupportedAlgorithm

from .completion_hook import CompletionConsumer
from .delivery_outbox import DeliveryOutbox
from .host_custody import CustodyError, HostCustody
from .runtime_bridge import Binding, SandboxTransport


REQUIRED_RECEIPT_FIELDS = ('source', 'podUid', 'container', 'uid', 'mountPath', 'keyFingerprint',
                           'configSha256', 'collectedAt', 'readDenied')
RECEIPT_MAX_AGE_SECONDS = 3600


def config_fingerprint(env=None):
    """This deployment's identity: changing issue/grant/execution/issuer/audience changes it."""
    env = env or os.environ
    parts = [env.get('BAYMAX_SIGNER_ISSUER'), env.get('BAYMAX_SIGNER_AUDIENCE'), env.get('BAYMAX_SIGNER_SUBJECT'),
             env.get('BAYMAX_SIGNER_ISSUE'), env.get('BAYMAX_SIGNER_GRANT'), env.get('BAYMAX_SIGNER_EXECUTION_REF')]
    return 'sha256:' + hashlib.sha256('|'.join(part or '' for part in parts).encode()).hexdigest()


def key_fingerprint(key_path):
    try:
        from cryptography.hazmat.primitives import serialization
        with open(key_path, 'rb') as handle:
            key = serialization.load_pem_private_key(handle.read(), password=None)
        public = key.public_key().public_bytes(serialization.Encoding.PEM,
                                               serialization.PublicFormat.SubjectPublicKeyInfo)
        return 'sha256:' + hashlib.sha256(public).hexdigest()
    except (OSError, ValueError, TypeError, UnsupportedAlgorithm):
        return None


def receipt_dir_trusted(receipt_path, receipt_dir, agent_uid):
    """The receipt must live in a deploy-managed directory the agent uid cannot write."""
    if not receipt_dir:
        return False, 'receipt_dir_required'
    try:
        directory = Path(receipt_dir).resolve()
        path = Path(receipt_path).resolve()
    except OSError:
        return False, 'receipt_path_unresolvable'
    if directory not in path.parents:
        return False, 'receipt_outside_deploy_dir'
    info = directory.stat()
    mode = stat.S_IMODE(info.st_mode)
    if mode & 0o022:
        return False, 'receipt_dir_group_or_other_writable'
    if agent_uid is not None and info.st_uid == agent_uid:
        return False, 'receipt_dir_owned_by_agent'
    return True, None


def boundary_check(key_path, agent_uid, receipt=None, receipt_dir=None, env=None, now=None):
    """Decide whether a *verified* OS boundary exists.

    Only a deploy-collector receipt bound to the pod, container, uid, mount, key and this
    deployment can verify the boundary. Anything a caller can write by hand (including a JSON file
    it created itself) is at most "material to be checked" and never enables signing.
    """
    info = Path(key_path).stat() if Path(key_path).exists() else None
    key_uid = info.st_uid if info else None
    mode = stat.S_IMODE(info.st_mode) if info else None
    reasons = []
    verdict = None
    verified_by = 'declaration'
    if key_uid is None:
        reasons.append('key_missing'); verdict = 'key_missing'
    elif mode & 0o077:
        reasons.append('key_group_or_other_readable'); verdict = 'key_permissions_too_open'
    elif agent_uid is None:
        # Unknown agent identity must fail closed, never pass by omission.
        reasons.append('agent_identity_unknown'); verdict = 'agent_identity_unknown'
    elif key_uid == agent_uid:
        reasons.append('agent_and_host_share_uid'); verdict = 'no_os_boundary'
    else:
        verdict = 'declared_separation_unverified'
        reasons.append('agent_separation_not_verified')

    if verdict == 'declared_separation_unverified':
        missing = [field for field in REQUIRED_RECEIPT_FIELDS if not (receipt or {}).get(field) and field != 'readDenied']
        if receipt is None:
            reasons.append('boundary_receipt_absent')
        elif receipt.get('source') != 'deploy-collector':
            reasons.append('receipt_not_from_deploy_collector')
        elif missing:
            reasons.extend('receipt_missing:' + field for field in missing)
        elif receipt.get('uid') != agent_uid:
            reasons.append('receipt_uid_mismatch')
        elif receipt.get('readDenied') is not True:
            reasons.append('receipt_did_not_show_denial')
        elif receipt.get('keyFingerprint') != key_fingerprint(key_path):
            reasons.append('receipt_key_fingerprint_mismatch')
        elif receipt.get('configSha256') != config_fingerprint(env):
            reasons.append('receipt_config_mismatch')
        elif str(receipt.get('mountPath')) != str(Path(key_path).parent):
            reasons.append('receipt_mount_mismatch')
        elif abs(int(now if now is not None else __import__('time').time()) - int(receipt.get('collectedAt') or 0)) > RECEIPT_MAX_AGE_SECONDS:
            reasons.append('receipt_stale')
        else:
            trusted, why = receipt_dir_trusted(receipt.get('path') or '', receipt_dir, agent_uid)
            if not trusted:
                reasons.append(why)
            else:
                # A receipt file is still caller-writable material: "source":"deploy-collector" is a
                # string the caller types. This process cannot attest the collector, so it never
                # upgrades a file to a verified boundary. Signing stays closed until a controlled
                # deploy path hands over an attestation this process can actually verify.
                verdict = 'receipt_material_unverified'
                reasons = ['receipt_is_not_control_attested']
    satisfied = verdict == 'verified_os_boundary'
    return {
        'host_uid': os.getuid(),
        'key_owner_uid': key_uid,
        'key_mode': oct(mode) if mode is not None else None,
        'agent_uid': agent_uid,
        'osBoundarySatisfied': satisfied,
        'verifiedBy': verified_by,
        'verdict': verdict,
        'reasons': reasons,
        'requires_new_privilege_for_full_isolation': not satisfied,
        'how_to_obtain_boundary': 'run the host under a dedicated macOS user (needs an admin to create the '
                                  'account and its 0600 key) or inside a container/host the agent cannot read',
        'how_to_verify': 'collect the boundary receipt from the agent container through the deploy collector '
                         'and pass it with --boundary-receipt plus --receipt-dir (deploy-managed, not agent-writable)',
    }


def _read_receipt(path):
    """Receipt material only. Never sufficient on its own: see boundary_check."""
    if not path:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            receipt = json.load(handle)
        receipt['path'] = str(path)
        return receipt
    except (OSError, ValueError):
        return None


def run_once(consumer, transport):
    """Sweep admitted-but-unfinished runs: recover a lost completion event, then write back."""
    results = []
    for execution_ref in consumer.unfinished_runs():
        recovered = consumer.recover_from_canonical(execution_ref)
        entry = {'executionRef': execution_ref, 'recovery': recovered.get('status')}
        if recovered.get('status') in ('recovered_terminal', 'awaiting_writeback'):
            try:
                entry['writeback'] = consumer.resume(execution_ref).get('status')
            except (OSError, RuntimeError, sqlite3.Error, ValueError) as error:  # keep the run pending; never re-run business work
                entry['writeback'] = 'pending:' + type(error).__name__
        results.append(entry)
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description='Baymax sandbox delivery host')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--key')
    parser.add_argument('--agent-uid', type=int)
    parser.add_argument('--agent-probe', help='informational only: never enables signing')
    parser.add_argument('--boundary-receipt', help='receipt collected by the deploy collector')
    parser.add_argument('--receipt-dir', help='deploy-managed directory holding the receipt')
    parser.add_argument('--issuer')
    parser.add_argument('--issue')
    parser.add_argument('--grant')
    parser.add_argument('--subject')
    parser.add_argument('--delegator')
    parser.add_argument('--execution-ref')
    parser.add_argument('--deadline', type=int)
    parser.add_argument('--state')
    parser.add_argument('--intents')
    parser.add_argument('--outbox')
    parser.add_argument('--session')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args(argv)

    if args.check:
        try:
            if not args.key:
                raise CustodyError('key path required')
            custody = HostCustody.load(args.key, issuer=args.issuer or 'unconfigured',
                                       binding=Binding(args.issue or '1', args.grant or '11111111-1111-4111-8111-111111111111',
                                                       args.subject or 'plankton:unconfigured',
                                                       args.delegator or '1', args.execution_ref or 'unconfigured',
                                                       args.deadline or 0))
            fingerprint = custody.fingerprint()
            custody.close()
        except CustodyError:
            fingerprint = None
        report = boundary_check(args.key, args.agent_uid, receipt=_read_receipt(args.boundary_receipt),
                                receipt_dir=args.receipt_dir)
        report['keyFingerprint'] = fingerprint
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 0 if report['osBoundarySatisfied'] else 2

    required = ['key', 'agent_uid', 'issuer', 'issue', 'grant', 'subject', 'delegator', 'execution_ref', 'deadline',
                'state', 'intents', 'outbox', 'session', 'boundary_receipt', 'receipt_dir']
    missing = [name for name in required if getattr(args, name) in (None, '')]
    if missing:
        print(json.dumps({'status': 'blocked_configuration', 'missing': missing}), file=sys.stderr)
        return 2
    boundary = boundary_check(args.key, args.agent_uid, receipt=_read_receipt(args.boundary_receipt),
                              receipt_dir=args.receipt_dir)
    if not boundary['osBoundarySatisfied'] or boundary.get('verifiedBy') != 'deploy_collector_receipt':
        print(json.dumps({'status': 'blocked_no_verified_os_boundary', 'report': boundary}, ensure_ascii=False), file=sys.stderr)
        return 3
    binding = Binding(args.issue, args.grant, args.subject, args.delegator, args.execution_ref, args.deadline)
    custody = HostCustody.load(args.key, issuer=args.issuer, binding=binding)
    transport = SandboxTransport(custody.issuer)
    outbox = DeliveryOutbox(args.outbox)
    try:
        consumer = CompletionConsumer(args.state, args.intents, args.session, outbox, transport=transport)
        results = run_once(consumer, transport)
        print(json.dumps({'status': 'swept', 'results': results}, ensure_ascii=False))
        return 0
    finally:
        outbox.close()
        custody.close()


if __name__ == '__main__':
    raise SystemExit(main())
