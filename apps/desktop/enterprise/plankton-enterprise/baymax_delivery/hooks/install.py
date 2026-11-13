"""Explicit hook installation for one profile (never runs automatically).

The gateway only discovers hooks under the active profile's ``hooks/`` directory, and it imports a
hook's ``handler.py`` without adding any plugin directory to ``sys.path``. So an installed hook must
carry its own pointer to the package it needs. This module is that supported, reproducible entry:
it copies ``HOOK.yaml`` and ``handler.py`` into ``<profile>/hooks/baymax-delivery/`` and writes the
absolute plugin root next to them.

Nothing here touches a real user profile unless the caller names it::

    python -m baymax_delivery.hooks.install --hermes-home /tmp/isolated-home --dry-run
    python -m baymax_delivery.hooks.install --hermes-home /tmp/isolated-home
"""

import argparse
import json
import shutil
from pathlib import Path

HOOK_NAME = 'baymax-delivery'
_HERE = Path(__file__).resolve().parent / HOOK_NAME


def plugin_root():
    """Directory that must be importable for ``baymax_delivery`` to resolve."""
    return Path(__file__).resolve().parents[2]


def install(hermes_home, dry_run=False, force=False):
    """Install the hook into ``<hermes_home>/hooks/baymax-delivery`` and return what was written."""
    home = Path(hermes_home).expanduser().resolve()
    target = home / 'hooks' / HOOK_NAME
    if target.exists() and not force:
        existing = (target / 'plugin_root.txt')
        if not existing.exists() or existing.read_text().strip() != str(plugin_root()):
            raise FileExistsError(f'{target} already holds a different hook; inspect before using --force')
    plan = {'hermesHome': str(home), 'target': str(target), 'pluginRoot': str(plugin_root()),
            'dryRun': bool(dry_run), 'files': ['HOOK.yaml', 'handler.py', 'plugin_root.txt']}
    if dry_run:
        return plan
    target.mkdir(parents=True, exist_ok=True)
    for name in ('HOOK.yaml', 'handler.py'):
        shutil.copyfile(_HERE / name, target / name)
    (target / 'plugin_root.txt').write_text(str(plugin_root()) + '\n')
    plan['installed'] = True
    return plan


def main(argv=None):
    parser = argparse.ArgumentParser(prog='baymax_delivery.hooks.install',
                                     description='Install the Baymax delivery hook into one profile.')
    parser.add_argument('--hermes-home', required=True,
                        help='profile home that owns hooks/ (e.g. /tmp/isolated-home)')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args(argv)
    print(json.dumps(install(args.hermes_home, dry_run=args.dry_run, force=args.force), sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
