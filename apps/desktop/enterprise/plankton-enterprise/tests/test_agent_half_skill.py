"""W2 · the agent half of plankton-enterprise registers the pack's ONE skill.

Design: N7 §8 (W2) + N2 §0.1 (concept convergence — "the domain command surface /
the instructions the agent may emit / how to onboard a new domain" is carried by
ONE skill). The registration path is the engine's own read-only plugin-skill hook
(``ctx.register_skill``): the engine copies nothing into ``~/.hermes/skills``, so
this side performs **zero writes** and touches no enterprise data.

These tests use a recording stub for ``ctx`` — no engine, no home directory, no
network, no credential.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
AGENT_HALF = PLUGIN_ROOT / "__init__.py"


def load_agent_half():
    spec = importlib.util.spec_from_file_location("plankton_enterprise_agent_half", AGENT_HALF)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def half():
    return load_agent_half()


class RecordingContext:
    """The smallest shape of ``PluginContext`` this half is allowed to use."""

    def __init__(self, *, with_hook: bool = True) -> None:
        self.calls: list[tuple[str, Path]] = []
        self.descriptions: list[str] = []
        if with_hook:
            self.register_skill = self._register_skill  # type: ignore[attr-defined]

    def _register_skill(self, name, path, description=""):
        self.calls.append((name, Path(path)))
        self.descriptions.append(description)
        return None


def test_register_hands_the_one_skill_to_the_engine(half):
    ctx = RecordingContext()
    assert half.register(ctx) is None
    assert len(ctx.calls) == 1, "this half registers exactly ONE skill"
    name, path = ctx.calls[0]
    assert name == "baymax"
    assert path == half.SKILL_PATH
    assert path.is_file(), "the skill must actually ship in the plugin payload"
    assert path.read_text(encoding="utf-8").startswith("---\n"), "an engine skill carries frontmatter"
    assert ctx.descriptions[0].strip(), "the skill must come with a description"


def test_the_registered_skill_carries_the_three_things_n2_requires(half):
    body = half.SKILL_PATH.read_text(encoding="utf-8")
    # (a) the domain command surface
    for command in ("+project-list", "+type-list", "+issue-list", "+issue-get"):
        assert command in body
    # (b) the instructions the agent may emit
    for instruction in ("plankton-baymax-new", "plankton-baymax-update", "plankton-baymax-plan"):
        assert instruction in body
    # (c) onboarding a new domain
    assert "接一个新域" in body


def test_a_missing_skill_file_is_fail_closed(half, monkeypatch, tmp_path):
    """Our own payload defect must never be swallowed: it raises."""
    monkeypatch.setattr(half, "SKILL_PATH", tmp_path / "skills" / "baymax" / "SKILL.md")
    with pytest.raises(RuntimeError, match="skill is missing"):
        half.register(RecordingContext())


def test_an_engine_without_the_hook_is_reported_loudly_and_does_not_take_the_plugin_down(half, caplog):
    """A HOST capability gap is not our defect: report it, keep the plugin alive."""
    ctx = RecordingContext(with_hook=False)
    with caplog.at_level(logging.WARNING, logger=half.__name__):
        assert half.register(ctx) is None
    assert ctx.calls == []
    assert any("register_skill" in record.message for record in caplog.records), (
        "a missing hook must be reported, never silently ignored"
    )


def test_the_agent_half_performs_no_write(half):
    """Source-level: this half must not open anything for writing (read-only registration)."""
    source = AGENT_HALF.read_text(encoding="utf-8")
    for forbidden in ("open(", "write_text(", "write_bytes(", "mkdir(", "shutil", "os.replace"):
        assert forbidden not in source, f"the agent half must not write ({forbidden})"
