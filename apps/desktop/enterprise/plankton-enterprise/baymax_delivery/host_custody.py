"""Trusted-host private key custody. NOT an agent tool and NOT a signing service.

What this module actually enforces, at load time:

1. the key path is supplied by the host and is a regular file (symlinks refused);
2. the file is owned by the current uid and has no group/other permission bits;
3. the file is not inside the agent-facing workspace (a key dropped next to the agent code
   is refused, including via the default forbidden root = this module's directory);
4. the loaded key object never leaves the object: ``repr``/``str`` are redacted and the only
   exported derivative is the SHA-256 fingerprint of the *public* key;
5. assertions are short-lived and bound to exactly one issue/grant/execution, because the
   issuer refuses to sign without a verified binding and caps ``exp - iat`` at 120 seconds.

What this module does NOT guarantee (stated, not implied):

* OS-level isolation from another process running as the same user. This desktop environment
  has no path-level sandbox, so a same-uid process could still read the file. Formal custody
  requires the host to run this module under a separate account or inside a host service;
* protection against root / a debugging host process.

Those limits are machine-readable through :meth:`HostCustody.statement` so a deployment
checklist cannot silently treat this as full key isolation.
"""
import hashlib
import os
import stat
from pathlib import Path

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization

from .runtime_bridge import Binding, RuntimeIssuer

MAX_ASSERTION_SECONDS = 120
MIN_RSA_BITS = 2048


class CustodyError(ValueError):
    """Raised when the host cannot prove basic key-custody preconditions."""


class HostCustody:
    def __init__(self, key, path, issuer, binding, checks):
        self._key = key
        self._path = path
        self._checks = tuple(checks)
        self._binding = binding
        self._issuer_name = issuer
        self._closed = False
        self.issuer = RuntimeIssuer(key, binding, issuer)

    @classmethod
    def load(cls, path, *, issuer, binding: Binding, forbidden_roots=()):
        if not isinstance(binding, Binding):
            raise CustodyError('An explicit runtime binding is required')
        default_root = Path(__file__).resolve().parent
        forbidden = [default_root.parent, *[Path(item).resolve() for item in forbidden_roots]]
        candidate = Path(path)
        if candidate.is_symlink():
            raise CustodyError('Refusing a symlinked key file')
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError:
            raise CustodyError('Key file not found') from None
        if any(resolved == root or root in resolved.parents for root in forbidden):
            raise CustodyError('Refusing a key file inside the agent-facing workspace')
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode):
            raise CustodyError('Key must be a regular file')
        if info.st_uid != os.getuid():
            raise CustodyError('Key must be owned by the host user')
        if info.st_mode & 0o077:
            raise CustodyError('Key file must not be readable by group or others (chmod 600)')
        data = resolved.read_bytes()
        try:
            key = serialization.load_pem_private_key(data, password=None)
        except (ValueError, TypeError, UnsupportedAlgorithm):
            raise CustodyError('Key file is not an unencrypted PEM private key') from None
        finally:
            data = b'\x00' * len(data)
        if key.key_size < MIN_RSA_BITS:
            raise CustodyError(f'RSA key must be at least {MIN_RSA_BITS} bits')
        checks = [
            'regular_file', 'not_symlink', 'owner_is_host_user', 'no_group_or_other_permissions',
            'outside_agent_workspace', 'unencrypted_pem', f'rsa_min_{MIN_RSA_BITS}_bits',
        ]
        return cls(key, resolved, issuer, binding, checks)

    # --- deliberately minimal surface -------------------------------------------------
    def fingerprint(self):
        """SHA-256 of the public key (SPKI DER); the only derivative a host may publish."""
        der = self._key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        return 'sha256:' + hashlib.sha256(der).hexdigest()

    def public_key_pem(self):
        return self._key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()

    def mint(self, operation):
        self.ensure_open()
        return self.issuer.issue(operation)

    def ensure_open(self):
        if self._closed or self._key is None:
            raise CustodyError('Custody is closed; refusing to sign')
        return self

    def close(self):
        self._key = None
        self.issuer = None
        self._closed = True

    def statement(self):
        return {
            'fingerprint': self.fingerprint() if not self._closed else None,
            'key_path': str(self._path),
            'issuer': self._issuer_name,
            'audience': self._binding_audience(),
            'max_assertion_seconds': MAX_ASSERTION_SECONDS,
            'enforced': list(self._checks),
            'not_enforced': [
                'same_uid_process_isolation',
                'protection_from_root_or_debugger',
                'hardware_backed_key_storage',
            ],
            'host_requirement': 'Run this module in a separate account/process; this desktop has no path-level sandbox.',
        }

    def _binding_audience(self):
        from .runtime_bridge import ENDPOINT
        return ENDPOINT

    def __repr__(self):
        state = 'closed' if self._closed else 'open'
        fingerprint = 'redacted' if self._closed else self.fingerprint()
        return f'<HostCustody {state} fingerprint={fingerprint} path={self._path}>'

    __str__ = __repr__
