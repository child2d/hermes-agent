"""Plankton-side Baymax delivery bridge tests (imported from the sibling package directory).

The plugin directory name contains a hyphen, so — like the existing enterprise tests — the plugin
directory is put on ``sys.path`` explicitly instead of relying on packaging metadata.
"""

import pathlib
import sys

PLUGIN_DIR = pathlib.Path(__file__).resolve().parents[2]   # …/plankton-enterprise
PACKAGE_ROOT = PLUGIN_DIR / 'baymax_delivery'
REPO_ROOT = next(path for path in pathlib.Path(__file__).resolve().parents
                 if (path / 'gateway' / 'run_turn.py').exists())
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

EXTERNAL_BFF_REASON = (
    'external BFF verifier required: build the reviewed sectumsempra-bff candidate and point '
    'BAYMAX_BFF_DIST_MODULE at its compiled workload-identity module. The default repository '
    'suite runs without it by design; see tests/README-external.md for the pinned prerequisite.')
