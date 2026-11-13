"""Native HookRegistry integration for the delivered hook — with a real installation closure.

The hook is installed into an isolated profile home by ``baymax_delivery.hooks.install`` and then
discovered/dispatched by the repository's own ``HookRegistry`` inside a subprocess. No test-only
``sys.path`` injection into the handler and no ``HOOKS_DIR`` monkeypatching: if the installer stops
writing its pointer, or the handler stops resolving the package, these tests fail.
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
HOOK_SRC = ROOT / 'hooks' / 'baymax-delivery'


class NativeHookTests(unittest.TestCase):
    def test_ready_event_is_emitted_after_persistence_and_failure_classification(self):
        tree = ast.parse((REPO / 'gateway' / 'run_turn.py').read_text())
        lines = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in ('_hmwa_classify_turn_failure', '_hmwa_persist_turn_transcript'):
                    lines[node.func.attr] = node.lineno
                if (node.func.attr == 'emit' and node.args
                        and isinstance(node.args[0], ast.Constant)
                        and node.args[0].value == 'agent:delivery-ready'):
                    lines['ready'] = node.lineno
        self.assertIn('ready', lines)
        self.assertGreater(lines['ready'], lines['_hmwa_persist_turn_transcript'])
        self.assertGreater(lines['ready'], lines['_hmwa_classify_turn_failure'])

    def test_ready_event_carries_the_persisted_message_id_not_the_display_text(self):
        tree = ast.parse((REPO / 'gateway' / 'run_turn.py').read_text())
        keys = []
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == 'emit' and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value == 'agent:delivery-ready'):
                for argument in node.args[1:]:
                    if isinstance(argument, ast.Dict):
                        keys = [k.value for k in argument.keys
                                if isinstance(k, ast.Constant)]
        self.assertIn('canonical_message_id', keys)
        self.assertIn('session_id', keys)

    def test_installer_closure_is_discovered_by_the_real_registry(self):
        with tempfile.TemporaryDirectory(prefix='baymax-hook-') as home:
            done = subprocess.run(
                [sys.executable, str(ROOT / 'tests' / '_hook_install_probe.py'), home, str(PLUGIN_DIR),
                 str(REPO)],
                capture_output=True, text=True, timeout=240, check=False)
            self.assertEqual(done.returncode, 0, done.stderr[-2000:])
            report = json.loads(done.stdout.strip().splitlines()[-1])
            self.assertEqual(report['hooks'], ['baymax-delivery-bridge'])
            self.assertIn('agent:delivery-ready', report['events'])
            self.assertEqual(report['intentRow'], ['probe-run-1', ''])
            self.assertTrue(Path(report['installedTo']).is_dir())
            # The registry really dispatched: the terminal was accepted by the persisted row id,
            # the display text (with a footer) played no part, and a repeat start is a duplicate.
            self.assertEqual(report['ready'].get('status'), 'blocked_binding')
            self.assertEqual(report['payloadSummary'], 'probe output')
            self.assertEqual(report['payloadTerminalId'], 1)
            self.assertEqual(report['duplicateStart'].get('status'), 'duplicate')

    def test_a_hand_copied_handler_without_the_pointer_fails_loudly(self):
        with tempfile.TemporaryDirectory(prefix='baymax-hook-bare-') as home:
            target = Path(home) / 'hooks' / 'baymax-delivery'
            target.mkdir(parents=True)
            source = HOOK_SRC
            (target / 'HOOK.yaml').write_text((source / 'HOOK.yaml').read_text())
            (target / 'handler.py').write_text((source / 'handler.py').read_text())
            probe = Path(home) / 'probe.py'
            probe.write_text(
                'import importlib.util as u, sys\n'
                f's = u.spec_from_file_location("h", {str(target / "handler.py")!r})\n'
                'm = u.module_from_spec(s)\n'
                'try:\n'
                '    s.loader.exec_module(m)\n'
                'except ModuleNotFoundError as error:\n'
                '    print("MISSING", error)\n')
            done = subprocess.run([sys.executable, str(probe)], capture_output=True, text=True,
                                  timeout=120, check=False)
            self.assertIn('MISSING', done.stdout + done.stderr)


if __name__ == '__main__':
    unittest.main()
