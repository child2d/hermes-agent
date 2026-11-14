"""Runs the hermetic receipt cases in a clean child process, from the normal pytest entry.

``test_receipt_root_cases`` must own its interpreter (it re-points HOME/HERMES_HOME/TMPDIR and installs
a process-wide audit hook), so it cannot run inside a shared pytest session without poisoning it. This
module is the portable, automatic entry point: it spawns that module in a fresh interpreter, and fails
the parent test when the child exits non-zero or does not actually execute the cases. No manual env
variable, no developer-absolute path, and no extra CI wiring is required.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
REPO = TESTS_DIR.parents[5]
TARGETS = (
    (TESTS_DIR / 'test_receipt_root_cases.py', 8),
    (TESTS_DIR / 'test_hook_delivery_chain.py', 4),
)


def _run_hermetic(target, minimum):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HERMES_', 'PLANKTON_'))}
    env.update({
        'BAYMAX_HERMETIC_RECEIPT': '1',
        'PYTHONPATH': str(REPO),
        'PYTHONDONTWRITEBYTECODE': '1',
    })
    proc = subprocess.run(
        [sys.executable, '-B', '-m', 'pytest', '-p', 'no:cacheprovider', str(target), '-q'],
        cwd=str(REPO), env=env, capture_output=True, text=True, timeout=300, check=False,
    )
    output = proc.stdout + proc.stderr
    match = re.search(r'(\d+) passed', output)
    passed = int(match.group(1)) if match else 0
    assert passed >= minimum, (
        f'{target.name}: expected >= {minimum} passed, got {passed}\n{output[-3000:]}')
    assert proc.returncode == 0, f'{target.name}: failed (exit {proc.returncode})\n{output[-3000:]}'


def test_hermetic_receipt_cases_run_in_a_clean_child_process():
    for target, minimum in TARGETS:
        _run_hermetic(target, minimum)
