"""Passive enterprise CLI discovery plus fixed, bounded local version probes.

No installation, credential inspection, account commands or vendor API calls.
System installations win over the app's fallback copy in the active profile.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess

from hermes_constants import get_hermes_home
from hermes_platform.resolver import LookupContext, locate_command
from hermes_platform.resolver.known_dirs import homebrew_dirs, user_local_bin

VERSION_TIMEOUT_S = 3
_CLI_SPECS = (
    ("aliyun-cli", "Aliyun CLI", "阿里云命令行工具", "aliyun", "version"),
    ("lark-cli", "Lark CLI", "飞书命令行工具", "lark-cli", "--version"),
)


def _locations(command: str, home: Path) -> list[tuple[Path, str]]:
    # Electron fronts PATH with its bin. Exclude both active and launch-profile
    # bins so an override-bound request cannot pick another profile's app copy.
    profile_bins = {home / "bin"}
    launch_home = os.environ.get("HERMES_HOME")
    if launch_home:
        profile_bins.add(Path(launch_home).expanduser() / "bin")
    excluded = {str(path.absolute()) for path in profile_bins}
    path = os.pathsep.join(
        entry for entry in os.environ.get("PATH", "").split(os.pathsep)
        if entry and str(Path(entry).expanduser().absolute()) not in excluded
    )
    resolution = locate_command(
        command, LookupContext(path=path),
        known_dirs=(*homebrew_dirs(), *user_local_bin()),
    )
    candidates = []
    if resolution.found:
        candidates.append((Path(resolution.command[0]).absolute(), "system"))
    bundled = locate_command(str(home / "bin" / command))
    if bundled.found:
        candidate = Path(bundled.command[0])
        candidates.append((candidate, "system" if candidate.is_symlink() else "app"))
    return candidates


def list_clis() -> dict:
    home = get_hermes_home()
    tools = []
    for cli_id, name, description, command, version_arg in _CLI_SPECS:
        row = {
            "id": cli_id, "name": name, "description": description,
            "command": f"{command} --help", "available": False,
            "source": None, "path": None, "version": "",
        }
        for path, source in _locations(command, home):
            row.update(source=source, path=str(path))
            # A version probe needs no inherited credentials or profile auth state.
            env = {key: os.environ[key] for key in ("HOME", "PATH", "SYSTEMROOT", "WINDIR") if key in os.environ}
            env.update(HERMES_HOME=str(home), LANG="C.UTF-8", LC_ALL="C.UTF-8")
            env["PATH"] = os.pathsep.join(dict.fromkeys(entry for entry in (
                *env.get("PATH", "").split(os.pathsep),
                *map(str, homebrew_dirs()), *map(str, user_local_bin()),
            ) if entry))
            try:
                result = subprocess.run(
                    [str(path), version_arg], stdin=subprocess.DEVNULL,
                    capture_output=True, text=True, errors="replace",
                    timeout=VERSION_TIMEOUT_S, check=False, env=env,
                )
                if result.returncode:
                    row["error"] = f"version probe exited with code {result.returncode}"
                else:
                    row["version"] = (result.stdout.strip() or result.stderr.strip())[:500]
                    if not row["version"]:
                        row["error"] = "version probe returned no version"
                    else:
                        row["available"] = True
                        row.pop("error", None)
                        break
            except subprocess.TimeoutExpired:
                row["error"] = "version probe timed out"
            except OSError:
                row["error"] = "version probe could not start"
        tools.append(row)
    return {"tools": tools}
