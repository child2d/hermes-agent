"""plankton-enterprise dashboard backend — mounted at ``/api/plugins/plankton-enterprise/``.

One read-only surface in this batch: the local ``shaoke-cli`` tool catalog.

Red lines this file obeys (see PLANKTON-MIGRATION-BATCH2.md §D3):
  * It NEVER reads, writes, caches or proxies ``~/.shaoke/tokens.json``. It runs
    ``shaoke-cli tools list``, which is an unauthenticated, credential-free
    command (it prints the full catalog whether or not the CLI is logged in).
  * No execution entry point and no enable/disable switch — the catalog is a
    listing. The only subprocess is the fixed ``tools list`` invocation.

Failure taxonomy (four distinguishable kinds, mirroring the old tool-catalog and
PLK-REQ-0027): ``cli-missing`` / ``cli-failed`` / ``not-json`` / ``shape-mismatch``.
An EMPTY catalog is a SUCCESS (``{ok: true, systems: []}``) — never conflated with
a failure, so "no tools" and "CLI broken" are visually different.

Resolution is enterprise-only: the CLI comes from ``<HERMES_HOME>/bin`` (or an
explicit ``PLANKTON_SHAOKE_CLI`` override). A same-named binary on ``PATH`` is
NEVER used as a working copy — its absence of the enterprise copy is reported as
``cli-missing`` (KI-PLANKTON-0013), never silently downgraded.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Optional, Tuple

from fastapi import APIRouter

router = APIRouter()

CLI_NAME = "shaoke-cli"
TOOLS_LIST_TIMEOUT_S = 30
RAW_EXCERPT_MAX = 2000

# Failure kinds a caller can branch on. Kept as a closed set so the UI cannot
# silently render an unrecognised failure as emptiness.
FAILURE_KINDS = ("cli-missing", "cli-failed", "not-json", "shape-mismatch")


def _hermes_home() -> Optional[Path]:
    """The engine home this backend was launched with.

    The desktop pins ``HERMES_HOME`` for every spawned backend, so it is present;
    the fallback resolves the same value the engine itself would use.
    """
    env = os.environ.get("HERMES_HOME")
    if env and env.strip():
        return Path(env).expanduser()
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore

        return Path(get_default_hermes_root())
    except Exception:
        return None


def resolve_cli() -> Tuple[Optional[str], str]:
    """Locate the ENTERPRISE ``shaoke-cli`` without ever reading credentials.

    Precedence: an explicit override → the enterprise copy at
    ``<HERMES_HOME>/bin`` (the one the desktop seeds and PATH-fronts).

    There is deliberately NO fallback to whatever ``PATH`` resolves. A personal
    ``~/.local/bin/shaoke-cli`` is a DIFFERENT artifact with unknown provenance
    and its own credentials; treating it as "the enterprise CLI" is a silent
    downgrade (KI-PLANKTON-0013). When the enterprise copy is absent this
    returns ``(None, "missing")`` so the caller reports an explicit
    ``cli-missing`` — a same-named binary found on PATH is surfaced only as a
    diagnostic hint (``personal_cli_path``), never used.
    """
    override = (os.environ.get("PLANKTON_SHAOKE_CLI") or "").strip()
    if override:
        candidate = Path(override).expanduser()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate), "override"

    home = _hermes_home()
    if home is not None:
        candidate = home / "bin" / CLI_NAME
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate), "enterprise"

    return None, "missing"


def personal_cli_path() -> Optional[str]:
    """A same-named CLI found on ``PATH`` — DIAGNOSTIC ONLY.

    Never returned by :func:`resolve_cli` as a working copy: it exists solely so
    a ``cli-missing`` failure can tell the user a personal copy was seen and
    ignored (so the message is not a bare "not found" when one *is* on PATH).
    """
    return shutil.which(CLI_NAME)


def _excerpt(text: str) -> str:
    return text if len(text) <= RAW_EXCERPT_MAX else text[:RAW_EXCERPT_MAX]


def _failure(kind: str, message: str, cli_path: Optional[str], cli_source: str, raw: str = "") -> dict:
    payload: dict[str, Any] = {
        "ok": False,
        "kind": kind,
        "error": message,
        "cliPath": cli_path,
        "cliSource": cli_source,
        "fetchedAt": int(time.time() * 1000),
    }
    if raw:
        payload["rawExcerpt"] = _excerpt(raw)
    return payload


@router.get("/tools")
def list_tools() -> dict:
    """Return the local tool catalog. Listing only — nothing is executed or toggled."""
    cli_path, cli_source = resolve_cli()

    if cli_path is None:
        payload = _failure(
            "cli-missing",
            "找不到本机 shaoke-cli（企业副本应在引擎 home 的 bin 目录下）",
            None,
            cli_source,
        )
        stray = personal_cli_path()
        if stray:
            home = _hermes_home()
            expected = (home / "bin" / CLI_NAME) if home is not None else None
            payload["note"] = (
                f"PATH 上存在同名 CLI（个人副本）{stray}，已按企业口径忽略"
                + (f"；企业副本应为 {expected}" if expected is not None else "")
            )
        return payload

    try:
        completed = subprocess.run(
            [cli_path, "tools", "list"],
            capture_output=True,
            text=True,
            timeout=TOOLS_LIST_TIMEOUT_S,
            # Environment is inherited (PATH/PYTHONUTF8), never augmented with a
            # token: `tools list` needs no credential and must not look like it does.
            check=False,
        )
    except subprocess.TimeoutExpired:
        return _failure("cli-failed", f"shaoke-cli tools list 超时（>{TOOLS_LIST_TIMEOUT_S}s）", cli_path, cli_source)
    except OSError as exc:
        return _failure("cli-failed", f"无法执行 shaoke-cli: {exc}", cli_path, cli_source)

    stdout = completed.stdout or ""
    stderr = completed.stderr or ""

    if completed.returncode != 0:
        return _failure(
            "cli-failed",
            f"shaoke-cli tools list 退出码 {completed.returncode}",
            cli_path,
            cli_source,
            raw=(stdout + ("\n" + stderr if stderr else "")),
        )

    try:
        parsed = json.loads(stdout)
    except (ValueError, TypeError):
        return _failure("not-json", "shaoke-cli tools list 输出不是 JSON", cli_path, cli_source, raw=stdout)

    services = parsed.get("data", {}).get("services") if isinstance(parsed, dict) else None
    if not isinstance(services, list):
        return _failure(
            "shape-mismatch",
            "shaoke-cli tools list 输出缺少 data.services 列表",
            cli_path,
            cli_source,
            raw=stdout,
        )

    # An empty list is a real, successful answer — not a failure.
    return {
        "ok": True,
        "systems": services,
        "count": len(services),
        "cliPath": cli_path,
        "cliSource": cli_source,
        "fetchedAt": int(time.time() * 1000),
    }
