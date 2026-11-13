"""Native HookRegistry integration for the delivered hook — with a real installation closure.

Three processes, no shared state:

1. **install** — ``python -m baymax_delivery.hooks.install --hermes-home <tmp>`` writes
   ``HOOK.yaml`` / ``handler.py`` / ``plugin_root.txt`` into an isolated profile.
2. **discover** — a clean process that puts only the repository on ``sys.path`` (never the plugin
   directory) and has not imported ``baymax_delivery``; the gateway's own ``HookRegistry`` discovers
   the hook, whose handler resolves the package through the pointer.
3. **bare** — the same clean environment with the pointer removed: discovery must load **zero**
   hooks, and ``baymax_delivery`` must stay unimportable.

Nothing here patches ``HOOKS_DIR`` or injects the plugin directory into the handler's process.
"""

import ast
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import _path_setup

ROOT = _path_setup.PACKAGE_ROOT
REPO = _path_setup.REPO_ROOT
PLUGIN_DIR = ROOT.parent


def _install(home):
    return subprocess.run(
        [sys.executable, '-m', 'baymax_delivery.hooks.install', '--hermes-home', home],
        capture_output=True, text=True, timeout=120, check=False, cwd=str(PLUGIN_DIR))


def _probe(mode, home):
    return subprocess.run(
        [sys.executable, str(ROOT / 'tests' / '_hook_install_probe.py'), mode, home,
         str(PLUGIN_DIR), str(REPO)],
        capture_output=True, text=True, timeout=240, check=False)


class NativeHookTests(unittest.TestCase):
    def test_ready_event_is_emitted_after_persistence_and_failure_classification(self):
        tree = ast.parse((REPO / 'gateway' / 'run_turn.py').read_text())
        lines = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = getattr(node.func, 'attr', None) or getattr(node.func, 'id', None)
                if name in ('_hmwa_classify_turn_failure', '_hmwa_persist_turn_transcript',
                            'notify_delivery_ready'):
                    lines['ready' if name == 'notify_delivery_ready' else name] = node.lineno
        self.assertIn('ready', lines)
        self.assertGreater(lines['ready'], lines['_hmwa_persist_turn_transcript'])
        self.assertGreater(lines['ready'], lines['_hmwa_classify_turn_failure'])

    def test_the_notification_is_optional_and_receipt_driven(self):
        source = (REPO / 'gateway' / 'run_turn.py').read_text()
        self.assertIn('delivery_terminal_receipt_provider', source)
        notify = (REPO / 'gateway' / 'delivery_notify.py').read_text()
        self.assertIn('if provider is None', notify)
        self.assertNotIn('get_messages', notify)

    def test_installer_closure_is_discovered_by_a_clean_process(self):
        with tempfile.TemporaryDirectory(prefix='baymax-hook-') as home:
            installed = _install(home)
            self.assertEqual(installed.returncode, 0, installed.stderr[-2000:])
            done = _probe('discover', home)
            self.assertEqual(done.returncode, 0, done.stdout[-2000:] + done.stderr[-2000:])
            report = json.loads(done.stdout.strip().splitlines()[-1])
            self.assertEqual(report['hooks'], ['baymax-delivery-bridge'])
            self.assertFalse(report['pluginRootOnPath'])
            self.assertFalse(report['preimported'])
            self.assertEqual(report['intentRow'], ['probe-run-1', ''])
            self.assertEqual(report['payloadSummary'], 'probe output')
            self.assertEqual(report['payloadTerminalId'], 1)
            self.assertEqual(report['duplicateStart'].get('status'), 'duplicate')

    def test_the_same_environment_without_the_pointer_loads_nothing(self):
        with tempfile.TemporaryDirectory(prefix='baymax-hook-bare-') as home:
            installed = _install(home)
            self.assertEqual(installed.returncode, 0, installed.stderr[-2000:])
            (Path(home) / 'hooks' / 'baymax-delivery' / 'plugin_root.txt').unlink()
            done = _probe('bare', home)
            self.assertEqual(done.returncode, 0, done.stdout[-2000:] + done.stderr[-2000:])
            report = json.loads(done.stdout.strip().splitlines()[-1])
            self.assertEqual(report['hooks'], [])
            self.assertFalse(report['importableAfterDiscovery'])


if __name__ == '__main__':
    unittest.main()
