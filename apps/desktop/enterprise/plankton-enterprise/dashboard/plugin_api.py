"""plankton-enterprise dashboard backend — mounted at ``/api/plugins/plankton-enterprise/``.

Two read/write surfaces ship in this batch:

  * ``GET /tools``  — the local ``shaoke-cli`` tool catalog (read-only listing).
  * ``GET/POST /skills*`` — the enterprise skill market: the approved-skill
    catalog (via ``shaoke-cli skillhub``), install / uninstall / enable /
    disable / update, version comparison and the local content hash.

DECISION (batch 2 step 2, PLANKTON-MIGRATION-BATCH2.md §D4)
-----------------------------------------------------------
"停用" maps to the ENGINE's OWN skill enable state, not a second store kept by
this app. The engine is the single source of truth for "is this skill active":
``config.yaml`` → ``skills.disabled``, read by ``agent.skill_utils`` and written
through ``hermes_cli.skills_config.get_disabled_skills`` /
``save_disabled_skills`` — the exact functions the engine's own
``PUT /api/skills/toggle`` route calls. We call the SAME functions in the SAME
process, so there is structurally no second state to drift. The engine HAS this
state and entry point (verified: ``hermes_cli/skills_config.py``,
``hermes_cli/web_routers/skills.py:379``), so the decision is implementable and
is implemented — no bespoke status file.

Red lines this file obeys (PLANKTON-MIGRATION-BATCH2.md §D3):
  * It NEVER reads, writes, caches or proxies ``~/.shaoke/tokens.json``. The
    ``tools list`` command is unauthenticated; ``skillhub +list`` likewise runs
    unauthenticated (verified). No token is ever read.
  * The skill store is ``<HERMES_HOME>/skills`` — never a personal tree. Writes
    are refused when the target resolves under ``~/.hermes*`` and there is NO
    fallback to a personal directory (PLK-REQ-0023).

Failure taxonomy (each kind is INDEPENDENTLY visible in the UI — never
silently collapsed into "no skills"):
  ``cli-missing`` / ``unauthorized`` / ``network-failed`` / ``not-json`` /
  ``shape-mismatch`` / ``no-bundle`` / ``download-failed`` / ``extract-failed``
  / ``write-failed`` / ``needs-confirm`` / ``blocked-personal-dir`` /
  ``enterprise-home-unavailable`` / ``hash-unavailable``.
An EMPTY catalog is a SUCCESS (``{ok: true, catalog: {ok: true, count: 0}}``).

Hash parity: the local content hash is computed by importing the engine's own
``tools.skills_guard.content_hash`` — the exact function the engine uses. There
is NO second (JS/Python) re-implementation of the digest in this batch, so the
"口径分叉" the old JS ``hashTree`` risked is impossible by construction.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional, Tuple

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

CLI_NAME = "shaoke-cli"
TOOLS_LIST_TIMEOUT_S = 30
# A skill zip download + unpack can be slower than a catalog listing.
SKILL_CLI_TIMEOUT_S = 60
RAW_EXCERPT_MAX = 2000
PAGE_SIZE = 50
MAX_PAGES = 20
LEDGER_SCHEMA = 1

# Personal trees the skill store must NEVER touch (PLK-REQ-0023). ``.hermes``
# covers ``~/.hermes`` and ``~/.hermes/profiles/*`` by prefix.
PERSONAL_TREES = (".hermes",)

# Failure kinds a caller can branch on. Kept as a closed set so the UI cannot
# silently render an unrecognised failure as emptiness.
FAILURE_KINDS = (
    "cli-missing",
    "cli-failed",
    "unauthorized",
    "network-failed",
    "not-json",
    "shape-mismatch",
    "no-bundle",
    "download-failed",
    "extract-failed",
    "write-failed",
    "needs-confirm",
    "bad-input",
    "blocked-personal-dir",
    "enterprise-home-unavailable",
    "hash-unavailable",
)

# Tokens that mark a CLI failure as an AUTH problem (distinct from a network or
# a malformed-output problem). Matched case-insensitively against stdout+stderr.
_UNAUTH_TOKENS = (
    "401",
    "403",
    "unauthorized",
    "unauthenticated",
    "未授权",
    "未登录",
    "请先登录",
    "login required",
    "not logged in",
    "invalid token",
)

# Tokens that mark a CLI failure as a NETWORK problem (the registry is
# unreachable) — again distinct from auth and from malformed output. A Go CLI
# surfaces these for a refused / unresolved / timed-out connection.
_NETWORK_TOKENS = (
    "connection refused",
    "connection reset",
    "no such host",
    "network is unreachable",
    "i/o timeout",
    "context deadline exceeded",
    "dial tcp",
    "tls handshake",
    "eof",
    "broken pipe",
    "connection attempt failed",
    "connectex",
    "无法连接",
    "连接超时",
    "网络不可达",
)


# ─────────────────────────────────────────────────────────────────────────────
# Home / CLI resolution (shared by both surfaces)
# ─────────────────────────────────────────────────────────────────────────────


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
    """A same-named CLI found on ``PATH`` — DIAGNOSTIC ONLY."""
    return shutil.which(CLI_NAME)


def _excerpt(text: str) -> str:
    text = text if isinstance(text, str) else ("" if text is None else str(text))
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


# ─────────────────────────────────────────────────────────────────────────────
# GET /tools — read-only local tool catalog (step 1)
# ─────────────────────────────────────────────────────────────────────────────


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


# ─────────────────────────────────────────────────────────────────────────────
# Skill market — helpers
# ─────────────────────────────────────────────────────────────────────────────


class InstallRequest(BaseModel):
    slug: str = ""
    reference: str = ""
    name: str = ""
    category: str = ""
    version: str = ""
    # ``confirm`` is the human-confirmation latch: a write that overwrites an
    # occupied slot (or a batch write) is REFUSED unless the caller passes True.
    confirm: bool = False
    # Explicit "install to a different slug than expected" is not a feature —
    # ``force`` only means "overwrite despite a slot conflict".
    pickedBy: str = ""


class UninstallRequest(BaseModel):
    reference: str = ""
    installPath: str = ""
    confirm: bool = False


class ToggleRequest(BaseModel):
    name: str = ""
    enabled: bool = True


def _skills_dir(home: Path) -> Path:
    """The engine's own skills directory — ``<HERMES_HOME>/skills``."""
    return home / "skills"


def _ledger_path(home: Path) -> Path:
    """Our ledger — under the enterprise home, never a personal tree."""
    return home / "plankton" / "skill-ledger.json"


def assert_outside_personal_trees(directory: Path, personal_home: Optional[Path] = None) -> None:
    """Refuse a skill store that resolves inside a personal tree (PLK-REQ-0023).

    Raises ``ValueError`` — never returns a "somewhere else" fallback.
    """
    base = (personal_home or Path(os.path.expanduser("~"))).resolve()
    target = Path(directory).resolve()
    for tree in PERSONAL_TREES:
        personal = (base / tree).resolve()
        if target == personal or str(target).startswith(str(personal) + os.sep):
            raise ValueError(f"落点落在个人环境内（{tree}），拒绝取用：{target}")


def _enterprise_home_usable(home: Path) -> Tuple[bool, str]:
    """The enterprise home must exist and be writable, or we refuse to act."""
    if not home.exists():
        return False, "企业侧引擎 home 未初始化（目录不存在），请先让管理员为本机完成企业安装"
    if not home.is_dir():
        return False, "企业侧引擎 home 不是目录"
    if not os.access(home, os.W_OK):
        return False, "企业侧引擎 home 不可写，请联系企业支持"
    return True, ""


def _normalize_bundle_path(value: str, *, allow_nested: bool) -> Optional[str]:
    """Engine install-path rules (mirrors ``tools/skills_hub_models._normalize_bundle_path``).

    Trim; ``\\`` → ``/``; drop empty and ``.`` segments; reject an absolute
    path, a ``..`` segment, a segment containing ``:``, or (when nested is not
    allowed) more than one segment. Returns ``None`` on any rejection — never
    silently renames or folds.
    """
    raw = (value or "").strip()
    if not raw:
        return None
    normalized = raw.replace("\\", "/")
    parts = [p for p in normalized.split("/") if p not in ("", ".")]
    if normalized.startswith("/") or not parts:
        return None
    if any(p == ".." for p in parts) or any(":" in p for p in parts):
        return None
    if not allow_nested and len(parts) != 1:
        return None
    return "/".join(parts)


def plan_install_path(name: str, category: str) -> Optional[str]:
    """``category/name`` (category empty → single-layer ``name``), engine rules."""
    skill_name = _normalize_bundle_path(name, allow_nested=False)
    if not skill_name:
        return None
    raw_category = (category or "").strip()
    if not raw_category:
        return skill_name
    parent = _normalize_bundle_path(raw_category, allow_nested=True)
    if not parent:
        return None
    return f"{parent}/{skill_name}"


def _skill_reference(entry: dict) -> str:
    """Stable identity: ``install.reference`` when present, else ``slug``."""
    install = entry.get("install") if isinstance(entry, dict) else None
    ref = ""
    if isinstance(install, dict):
        ref = str(install.get("reference") or "").strip()
    return ref or str(entry.get("slug") or "")


# ── engine content hash (SAME function, SAME process — no second impl) ────────


def engine_content_hash(target: Path) -> Optional[str]:
    """The engine's own ``tools.skills_guard.content_hash`` over ``target``.

    Imported live from the running engine so the digest CANNOT diverge from the
    engine's. Returns ``None`` when the import or the read fails — "cannot
    decide" is reported as such, never guessed.
    """
    try:
        from tools.skills_guard import content_hash  # type: ignore
    except Exception:
        return None
    try:
        return str(content_hash(Path(target)))
    except Exception:
        return None


# ── ledger ────────────────────────────────────────────────────────────────────


def read_ledger(home: Path) -> Tuple[list, Optional[str]]:
    """Read the ledger; a missing/corrupt file is an empty ledger + a note."""
    file = _ledger_path(home)
    try:
        raw = file.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("records"), list):
            return [], f"台账结构不符，按空处理：{file}"
        return [r for r in parsed["records"] if isinstance(r, dict)], None
    except FileNotFoundError:
        return [], None
    except Exception as exc:  # corrupt JSON, unreadable, …
        return [], f"台账读取失败，按空处理：{exc}"


def write_ledger(home: Path, records: list) -> None:
    """Atomic temp-then-rename write of the ledger."""
    file = _ledger_path(home)
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_name(file.name + ".tmp")
    tmp.write_text(json.dumps({"schema": LEDGER_SCHEMA, "records": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, file)


def _hash_state(recorded: Any, current: Optional[str]) -> str:
    """Compare a ledger record's hash with the on-disk hash (逐字).

    ``match`` / ``mismatch`` / ``missing`` (没落点) / ``unknown`` (算不出)。
    """
    rec = str(recorded or "").strip()
    if not current:
        return "missing"
    if not rec:
        return "unknown"
    return "match" if rec == current else "mismatch"


# ── CLI invocation (module-level for test injection) ─────────────────────────


def _exec_cli(cli_path: str, args: list, timeout_s: int) -> Tuple[int, str, str]:
    """Run the CLI. Raises ``FileNotFoundError`` for a missing binary."""
    completed = subprocess.run(
        [cli_path, *args],
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    return completed.returncode, completed.stdout or "", completed.stderr or ""


def _classify_cli_failure(returncode: int, stdout: str, stderr: str) -> Tuple[str, str]:
    """Map a non-zero CLI exit to a DISTINGUISHABLE failure kind.

    The CLI writes its structured errors to stderr (and sometimes stdout), so
    both are inspected. Auth beats network beats generic.
    """
    blob = f"{stdout}\n{stderr}".lower()
    for token in _UNAUTH_TOKENS:
        if token in blob:
            return "unauthorized", "shaoke-cli 未授权：请先在 CLI 自己的终端里完成授权"
    for token in _NETWORK_TOKENS:
        if token in blob:
            return "network-failed", "无法连接企业 SkillHub（网络不可达或超时）"
    return "cli-failed", f"shaoke-cli 退出码 {returncode}"


def _run_cli_json(cli_path: str, args: list, timeout_s: int = SKILL_CLI_TIMEOUT_S) -> dict:
    """Run a CLI command and parse its JSON envelope.

    Returns ``{ok: True, parsed}`` or ``{ok: False, kind, detail}`` where kind is
    one of the failure taxonomy members. An empty-but-valid envelope is success.
    """
    try:
        returncode, stdout, stderr = _exec_cli(cli_path, args, timeout_s)
    except FileNotFoundError:
        return {"ok": False, "kind": "cli-missing", "detail": {"message": f"找不到可执行的 {CLI_NAME}"}}
    except subprocess.TimeoutExpired:
        return {"ok": False, "kind": "network-failed", "detail": {"message": f"shaoke-cli 超时（>{timeout_s}s）"}}
    except OSError as exc:
        return {"ok": False, "kind": "cli-failed", "detail": {"message": f"无法执行 shaoke-cli: {exc}"}}

    if returncode != 0:
        kind, message = _classify_cli_failure(returncode, stdout, stderr)
        return {"ok": False, "kind": kind, "detail": {"message": message, "raw": _excerpt(stdout + "\n" + stderr)}}

    try:
        parsed = json.loads(stdout)
    except (ValueError, TypeError):
        return {"ok": False, "kind": "not-json", "detail": {"raw": _excerpt(stdout)}}
    if not isinstance(parsed, dict):
        return {"ok": False, "kind": "shape-mismatch", "detail": {"raw": _excerpt(stdout)}}
    return {"ok": True, "parsed": parsed}


def parse_skill_page(parsed: dict) -> dict:
    """Parse one ``skillhub +list`` page (already JSON-decoded).

    ``data.items`` must be a list; every item must carry a ``slug``. A
    half-shaped page is a ``shape-mismatch`` — never a partial list.
    """
    data = parsed.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {"ok": False, "kind": "shape-mismatch", "detail": {"reason": "缺少 data.items 列表"}}
    skills = []
    for item in data["items"]:
        if not isinstance(item, dict):
            return {"ok": False, "kind": "shape-mismatch", "detail": {"reason": "items 元素不是对象"}}
        slug = str(item.get("slug") or "").strip()
        if not slug:
            return {"ok": False, "kind": "shape-mismatch", "detail": {"reason": "条目缺少 slug"}}
        tags = [t for t in (item.get("tags") or []) if isinstance(t, str)] if isinstance(item.get("tags"), list) else []
        skills.append(
            {
                "slug": slug,
                "reference": _skill_reference(item),
                "name": str(item.get("name") or ""),
                "description": str(item.get("description") or ""),
                "category": str(item.get("category") or ""),
                "version": str(item.get("version") or ""),
                "author": str(item.get("author") or ""),
                "tags": tags,
                "installPath": plan_install_path(str(item.get("name") or ""), str(item.get("category") or "")),
            }
        )
    cursor = data.get("nextCursor")
    next_cursor = None if cursor in (None, "") else str(cursor)
    return {"ok": True, "skills": skills, "nextCursor": next_cursor}


def fetch_catalog(cli_path: str, page_size: int = PAGE_SIZE, max_pages: int = MAX_PAGES) -> dict:
    """Page through ``skillhub +list`` to completion.

    Returns ``{ok: True, skills, pages}`` or ``{ok: False, kind, detail}``.
    An empty catalog is ``ok: True, skills: []`` — a real, successful answer.
    """
    skills: list = []
    pages = 0
    page = 1
    while page <= max_pages:
        res = _run_cli_json(cli_path, ["skillhub", "+list", "--page", str(page), "--page-size", str(page_size)])
        if not res["ok"]:
            return {"ok": False, "kind": res["kind"], "detail": res.get("detail")}
        parsed = parse_skill_page(res["parsed"])
        if not parsed["ok"]:
            return {"ok": False, "kind": parsed["kind"], "detail": parsed.get("detail"), "page": page}
        skills.extend(parsed["skills"])
        pages += 1
        if not parsed["nextCursor"]:
            break
        page += 1
    return {"ok": True, "skills": skills, "pages": pages}


def fetch_disabled(cli_path: Optional[str] = None) -> dict:
    """The engine's disabled-skill set (``config.yaml`` → ``skills.disabled``).

    Read through the engine's OWN function so the value cannot diverge.
    """
    try:
        from hermes_cli.config import load_config  # type: ignore
        from hermes_cli.skills_config import get_disabled_skills  # type: ignore

        config = load_config()
        names = sorted(str(n) for n in get_disabled_skills(config))
        return {"ok": True, "names": names}
    except Exception as exc:
        return {"ok": False, "kind": "unreadable-config", "detail": {"message": str(exc)}}


def _derive_install_state(skill: dict, record: Optional[dict], on_disk: bool, disabled: Optional[bool]) -> str:
    """The already-installed state for one catalog entry (mirrors the old view)."""
    if not skill.get("installPath"):
        return "name-missing"
    if record and on_disk:
        if disabled is True:
            return "disabled"
        recorded = str(record.get("version") or "").strip()
        catalog = str(skill.get("version") or "").strip()
        if recorded and catalog:
            return "consistent" if recorded == catalog else "version-differs"
        return "version-unknown"
    if record and not on_disk:
        return "record-without-files"
    if not record and on_disk:
        return "version-unknown"
    return "not-installed"


# ─────────────────────────────────────────────────────────────────────────────
# GET /skills
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/skills")
def list_skills() -> dict:
    """The enterprise skill market: catalog + local install facts.

    A catalog fetch failure is reported in a nested ``catalog`` block so the
    page can still render the local install facts and show the failure — a
    catalog that could not be fetched is NEVER rendered as "no skills".
    """
    home = _hermes_home()
    if home is None:
        return _failure("enterprise-home-unavailable", "无法确定企业侧引擎 home", None, "missing")

    skills_path = _skills_dir(home)
    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {
            "ok": False,
            "kind": "blocked-personal-dir",
            "error": str(exc),
            "skillsPath": str(skills_path),
            "fetchedAt": int(time.time() * 1000),
        }

    usable, reason = _enterprise_home_usable(home)
    if not usable:
        return {
            "ok": False,
            "kind": "enterprise-home-unavailable",
            "error": reason,
            "home": str(home),
            "skillsPath": str(skills_path),
            "fetchedAt": int(time.time() * 1000),
        }

    cli_path, cli_source = resolve_cli()

    # Local facts first — they do not depend on the network.
    ledger_records, ledger_note = read_ledger(home)
    by_ref: dict = {}
    for record in ledger_records:
        ref = str(record.get("reference") or record.get("slug") or "")
        if ref:
            by_ref[ref] = record

    disabled_info = fetch_disabled()
    disabled_set = set(disabled_info.get("names") or []) if disabled_info.get("ok") else set()

    installed: list = []
    for record in ledger_records:
        install_path = str(record.get("installPath") or "")
        target = skills_path / install_path if install_path else None
        on_disk = bool(target and target.is_dir())
        current = engine_content_hash(target) if (target and on_disk) else None
        installed.append(
            {
                "reference": str(record.get("reference") or ""),
                "slug": str(record.get("slug") or ""),
                "name": str(record.get("name") or ""),
                "category": str(record.get("category") or ""),
                "version": str(record.get("version") or ""),
                "installPath": install_path,
                "installedAt": str(record.get("installedAt") or ""),
                "uninstalledAt": str(record.get("uninstalledAt") or ""),
                "files": record.get("files"),
                "onDisk": on_disk,
                "localHash": current,
                "hashState": _hash_state(record.get("contentHash"), current),
                "disabled": (str(record.get("name") or "") in disabled_set) if disabled_info.get("ok") else None,
            }
        )

    # Catalog — may fail; the failure is surfaced, never hidden.
    if cli_path is None:
        catalog = {
            "ok": False,
            "kind": "cli-missing",
            "detail": {"message": "找不到企业副本 shaoke-cli"},
        }
        catalog_skills: list = []
    else:
        fetched = fetch_catalog(cli_path)
        if fetched["ok"]:
            catalog = {"ok": True, "count": len(fetched["skills"]), "pages": fetched.get("pages", 0)}
            catalog_skills = fetched["skills"]
        else:
            catalog = {"ok": False, "kind": fetched["kind"], "detail": fetched.get("detail")}
            catalog_skills = []

    enriched: list = []
    for skill in catalog_skills:
        record = by_ref.get(skill["reference"]) or None
        install_path = skill.get("installPath")
        target = (skills_path / install_path) if install_path else None
        planned_on_disk = bool(target and target.is_dir())
        ledger_on_disk = bool(record and record.get("installPath") and (skills_path / str(record.get("installPath"))).is_dir())
        on_disk = planned_on_disk or ledger_on_disk
        current = engine_content_hash(target) if (target is not None and planned_on_disk) else None
        record_attested = bool(record) and _hash_state(record.get("contentHash"), current) == "match"
        effective_record = record if record_attested else None
        disabled_flag = None
        if disabled_info.get("ok"):
            disabled_flag = str(skill.get("name") or "").strip() in disabled_set
        enriched.append(
            {
                **skill,
                "onDisk": on_disk,
                "installState": _derive_install_state(skill, effective_record if planned_on_disk else None, planned_on_disk, disabled_flag),
                "recordedVersion": str(effective_record.get("version") or "") if effective_record else "",
                "localHash": current,
                "hashState": _hash_state(record.get("contentHash"), current) if record else None,
                "disabled": disabled_flag,
            }
        )

    return {
        "ok": True,
        "skills": enriched,
        "installed": installed,
        "catalog": catalog,
        "disabled": disabled_info,
        "count": len(enriched),
        "home": str(home),
        "skillsPath": str(skills_path),
        "ledgerPath": str(_ledger_path(home)),
        "ledgerNote": ledger_note,
        "cliPath": cli_path,
        "cliSource": cli_source,
        "personalCliPath": personal_cli_path() if cli_path is None else None,
        "fetchedAt": int(time.time() * 1000),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Write path — install / uninstall / enable / disable / update
# ─────────────────────────────────────────────────────────────────────────────


def _http_get(url: str, timeout_s: int = SKILL_CLI_TIMEOUT_S) -> bytes:
    """Fetch bytes from a presigned bundle URL. Module-level for test injection."""
    with urllib.request.urlopen(url, timeout=timeout_s) as response:  # noqa: S310 - CLI-provided presigned URL
        return response.read()


def _zip_entries(buffer: bytes) -> list:
    """Read a zip into ``[(posix_rel_path, bytes)]``.

    ZIP entry names are decoded UTF-8 when the UTF-8 flag is set; otherwise the
    raw bytes are recovered from Python's cp437 fallback and re-decoded as UTF-8
    (then GBK). This mirrors what the CLI actually ships (names carry no flag).
    """
    entries: list = []
    with zipfile.ZipFile(io.BytesIO(buffer)) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if not (info.flag_bits & 0x800):
                try:
                    raw = name.encode("cp437")
                    try:
                        name = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        name = raw.decode("gbk")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            entries.append((name.replace("\\", "/"), archive.read(info)))
    return entries


def strip_top_dir(entries: list) -> list:
    """Drop a single shared top-level directory (skillhub ships ``<name>/…``).

    A single ROOT-LEVEL file (e.g. a lone ``SKILL.md``) must NOT be mistaken for
    a directory — that would strip the only file and read as an empty package.
    """
    files = [(p, d) for p, d in entries if p and not p.endswith("/")]
    if not files:
        return []
    if any("/" not in p for p, _ in files):
        return files
    tops = {p.split("/")[0] for p, _ in files}
    if len(tops) != 1:
        return files
    top = next(iter(tops))
    stripped = [(p[len(top) + 1 :], d) for p, d in files]
    return [(p, d) for p, d in stripped if p]


def is_unsafe_rel_path(rel: str) -> bool:
    if not rel:
        return True
    if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
        return True
    return ".." in rel.split("/")


def _resolve_inside(skills_path: Path, install_path: str) -> Optional[Path]:
    """Resolve ``install_path`` strictly inside ``skills_path`` (no ``..`` escape)."""
    rel = (install_path or "").strip()
    if not rel or os.path.isabs(rel):
        return None
    root = skills_path.resolve()
    absolute = (root / rel).resolve()
    if absolute != root and not str(absolute).startswith(str(root) + os.sep):
        return None
    return absolute


def _install_skill(data: InstallRequest) -> dict:
    slug = (data.slug or "").strip()
    if not slug:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "slug 为空"}}
    ref = (data.reference or "").strip() or slug
    planned = plan_install_path(data.name, data.category)
    if not planned:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "技能名缺失，无法确定落点"}}

    home = _hermes_home()
    if home is None:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": "无法确定企业侧引擎 home"}}
    skills_path = _skills_dir(home)
    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {"ok": False, "kind": "blocked-personal-dir", "detail": {"message": str(exc), "skillsPath": str(skills_path)}}
    usable, reason = _enterprise_home_usable(home)
    if not usable:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": reason, "home": str(home)}}

    cli_path, cli_source = resolve_cli()
    if cli_path is None:
        return {"ok": False, "kind": "cli-missing", "detail": {"message": "找不到企业副本 shaoke-cli"}}

    target = skills_path / planned
    ledger_records, _ = read_ledger(home)

    def ref_of(record: dict) -> str:
        return str(record.get("reference") or record.get("slug") or "")

    owner = next((r for r in ledger_records if str(r.get("installPath") or "") == planned and ref_of(r) != ref), None)
    mine = next((r for r in ledger_records if ref_of(r) == ref and str(r.get("installPath") or "") == planned), None)
    occupied_on_disk = target.is_dir()
    current_hash = engine_content_hash(target) if occupied_on_disk else None
    mine_intact = bool(mine) and _hash_state(mine.get("contentHash"), current_hash) == "match"
    occupied_by_other = (not mine_intact) and (bool(owner) or occupied_on_disk)

    if occupied_by_other and not data.confirm:
        return {
            "ok": False,
            "kind": "needs-confirm",
            "detail": {
                "reason": "落点已被同名同分类的另一个技能占用，未改动磁盘",
                "plannedPath": planned,
                "occupiedBy": (
                    {"reference": ref_of(owner), "name": str(owner.get("name") or ""), "version": str(owner.get("version") or "")}
                    if owner
                    else None
                ),
                "onDiskWithoutLedger": occupied_on_disk and not owner,
            },
        }

    # Download the bundle via the CLI's presigned URL, then fetch its bytes.
    dl = _run_cli_json(cli_path, ["skillhub", "+download", "--slug", slug], SKILL_CLI_TIMEOUT_S)
    if not dl["ok"]:
        blob = json.dumps(dl.get("detail") or {}, ensure_ascii=False)
        if dl["kind"] == "cli-failed" and ("无 zip 包" in blob or "404" in blob):
            return {"ok": False, "kind": "no-bundle", "detail": {"reason": "平台侧这条技能没有包"}}
        return {"ok": False, "kind": dl["kind"], "detail": dl.get("detail")}

    url = ""
    payload = dl["parsed"].get("data")
    if isinstance(payload, dict):
        url = str(payload.get("url") or "")
    if not url:
        return {"ok": False, "kind": "shape-mismatch", "detail": {"reason": "download 响应里没有 data.url"}}

    try:
        buffer = _http_get(url)
    except Exception as exc:
        return {"ok": False, "kind": "download-failed", "detail": {"message": str(exc)}}

    try:
        entries = strip_top_dir(_zip_entries(buffer))
    except Exception as exc:
        return {"ok": False, "kind": "extract-failed", "detail": {"message": str(exc)}}
    if not entries:
        return {"ok": False, "kind": "extract-failed", "detail": {"message": "包里没有文件"}}
    unsafe = [p for p, _ in entries if is_unsafe_rel_path(p)]
    if unsafe:
        return {"ok": False, "kind": "extract-failed", "detail": {"message": "包内含不安全路径，已拒绝落盘", "paths": unsafe[:5]}}

    written = 0
    try:
        for rel, data_bytes in entries:
            dest = target / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data_bytes)
            written += 1
    except Exception as exc:
        return {"ok": False, "kind": "write-failed", "detail": {"message": str(exc), "written": written, "target": str(target)}}

    content_hash = engine_content_hash(target)
    if not content_hash:
        return {
            "ok": False,
            "kind": "hash-unavailable",
            "detail": {
                "message": "内容哈希取不到（落点刚写入却读不出内容），未写取用记录",
                "installPath": planned,
            },
        }

    record = {
        "reference": ref,
        "slug": slug,
        "name": str(data.name),
        "category": str(data.category),
        "version": str(data.version),
        "contentHash": content_hash,
        "installPath": planned,
        "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": written,
        "pickedBy": str(data.pickedBy or ""),
    }
    records = [record] + [
        r for r in ledger_records if ref_of(r) != ref and str(r.get("installPath") or "") != planned
    ]
    try:
        write_ledger(home, records)
    except Exception as exc:
        return {
            "ok": False,
            "kind": "write-failed",
            "detail": {"message": f"技能已落盘但台账写不进去：{exc}", "target": str(target)},
        }

    return {
        "ok": True,
        "record": record,
        "target": str(target),
        "files": written,
        "skillsPath": str(skills_path),
        "localHash": content_hash,
        "cliPath": cli_path,
        "cliSource": cli_source,
    }


def _uninstall_skill(data: UninstallRequest) -> dict:
    ref = (data.reference or "").strip()
    if not ref:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "技能标识缺失"}}

    home = _hermes_home()
    if home is None:
        return {"ok": False, "kind": "enterprise-home-unavailable", "detail": {"reason": "无法确定企业侧引擎 home"}}
    skills_path = _skills_dir(home)
    try:
        assert_outside_personal_trees(skills_path)
    except ValueError as exc:
        return {"ok": False, "kind": "blocked-personal-dir", "detail": {"message": str(exc), "skillsPath": str(skills_path)}}

    ledger_records, _ = read_ledger(home)

    def ref_of(record: dict) -> str:
        return str(record.get("reference") or record.get("slug") or "")

    record = next(
        (r for r in ledger_records if ref_of(r) == ref and (not data.installPath or str(r.get("installPath") or "") == data.installPath)),
        None,
    )
    if record is None:
        return {"ok": False, "kind": "no-record", "detail": {"reason": "台账里没有这条取用记录，本模块只卸载自己取用过的技能", "reference": ref}}

    target = _resolve_inside(skills_path, str(record.get("installPath") or ""))
    if target is None:
        return {"ok": False, "kind": "unsafe-path", "detail": {"reason": "记录的落点不在技能目录内，已拒绝", "installPath": str(record.get("installPath") or "")}}

    exists = target.is_dir()
    current = engine_content_hash(target) if exists else None
    changed = exists and _hash_state(record.get("contentHash"), current) == "mismatch"
    # Human confirmation is REQUIRED for every uninstall (it removes files); a
    # local modification additionally needs the same confirm (never a silent
    # delete of someone's edits).
    if not data.confirm:
        return {
            "ok": False,
            "kind": "needs-confirm",
            "detail": {
                "reason": "落点内容与取用时的记录不一致（本地被改动过）" if changed else "卸载会删除落点目录",
                "installPath": str(record.get("installPath") or ""),
                "contentChanged": changed,
            },
        }

    removed = False
    if exists:
        try:
            shutil.rmtree(target)
            removed = True
        except Exception as exc:
            return {"ok": False, "kind": "remove-failed", "detail": {"message": str(exc), "target": str(target)}}

    next_record = {**record, "uninstalledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    records = [
        next_record if (ref_of(r) == ref and str(r.get("installPath") or "") == str(record.get("installPath") or "")) else r
        for r in ledger_records
    ]
    try:
        write_ledger(home, records)
    except Exception as exc:
        return {"ok": False, "kind": "write-failed", "detail": {"message": f"落点已删但台账写不进去：{exc}"}}

    return {"ok": True, "removed": removed, "record": next_record, "target": str(target)}


def _set_skill_enabled(name: str, enabled: bool) -> dict:
    """Flip the ENGINE's own enable state for ``name``.

    Uses ``hermes_cli.skills_config`` — the exact functions behind the engine's
    ``PUT /api/skills/toggle`` route — so this app keeps NO second copy of the
    state. Fail-closed: if the engine config cannot be read or written we report
    the failure and change nothing.
    """
    skill_name = (name or "").strip()
    if not skill_name:
        return {"ok": False, "kind": "bad-input", "detail": {"reason": "技能名缺失"}}
    try:
        from hermes_cli.config import load_config  # type: ignore
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills  # type: ignore
    except Exception as exc:
        return {"ok": False, "kind": "engine-unavailable", "detail": {"message": f"引擎技能配置模块不可用：{exc}"}}

    try:
        try:
            from hermes_cli.web_routers._common import config_write_scope  # type: ignore

            scope = config_write_scope(None)
        except Exception:
            scope = contextlib.nullcontext()
        with scope:
            config = load_config()
            disabled = get_disabled_skills(config)
            if enabled:
                disabled.discard(skill_name)
            else:
                disabled.add(skill_name)
            save_disabled_skills(config, disabled)
    except Exception as exc:
        return {"ok": False, "kind": "write-failed", "detail": {"message": str(exc)}}

    return {"ok": True, "name": skill_name, "enabled": bool(enabled), "disabled": sorted(disabled)}


@router.post("/skills/install")
def install_skill(data: InstallRequest) -> dict:
    """Install (or refresh) one skill into ``<HERMES_HOME>/skills``."""
    return _install_skill(data)


@router.post("/skills/update")
def update_skill(data: InstallRequest) -> dict:
    """Update = re-install from the catalog (same landing rules)."""
    return _install_skill(data)


@router.post("/skills/uninstall")
def uninstall_skill(data: UninstallRequest) -> dict:
    """Remove a skill's landing directory; the ledger record is kept."""
    return _uninstall_skill(data)


@router.post("/skills/enable")
def enable_skill(data: ToggleRequest) -> dict:
    """Re-enable a skill through the engine's own enable state."""
    return _set_skill_enabled(data.name, True)


@router.post("/skills/disable")
def disable_skill(data: ToggleRequest) -> dict:
    """Disable a skill through the engine's own enable state."""
    return _set_skill_enabled(data.name, False)
