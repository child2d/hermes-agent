"""Contracts for failure visibility and caller-owned test-runner isolation."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def runner():
    spec = importlib.util.spec_from_file_location(
        "runner_diagnostics", Path(__file__).resolve().parents[2] / "scripts/run_tests_parallel.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_inline_failure_keeps_trace_before_long_summary(runner, capsys, tmp_path):
    output = "ROOT_CAUSE_TRACE\n" + "\n".join(f"FAILED case_{i}" for i in range(80))
    runner._print_inline_failure(tmp_path / "test_probe.py", output, tmp_path, ["--tb=long"])
    printed = capsys.readouterr().out
    assert "ROOT_CAUSE_TRACE" in printed
    assert all(line in printed for line in output.splitlines())
    assert "scripts/run_tests.sh test_probe.py --tb=long" in printed


def test_explicit_temp_root_is_authoritative(runner, monkeypatch, tmp_path):
    monkeypatch.setenv("PYTEST_DEBUG_TEMPROOT", str(tmp_path))
    monkeypatch.setattr(runner.tempfile, "gettempdir", lambda: str(tmp_path))
    root = Path(runner._runner_scratch_root())
    assert root.parent == tmp_path
    assert root.is_dir()


@pytest.mark.parametrize("count", [3, 6, 9, 12])
def test_partitions_do_not_drop_or_repeat_files(runner, count, tmp_path):
    files = [tmp_path / f"test_{i:04d}.py" for i in range(103)]
    buckets = [runner._slice_files(list(reversed(files)) if i % 2 else files,
                                  i, count, {"different-per-runner": float(i)}, tmp_path)
               for i in range(1, count + 1)]
    joined = [f for bucket in buckets for f in bucket]
    assert sorted(joined) == sorted(files)
    assert len(joined) == len(set(joined))
