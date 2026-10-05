"""The enterprise (Plankton) shared-metrics default.

The enterprise build must not ask "Help improve Hermes / send to Nous". The Electron main stamps
``HERMES_ENTERPRISE=1`` into the spawned backend; the backend materializes the local-only answer
into the SAME config keys the offer writes, so every surface reads a decided, send-off opt-in and
the question is never shown. These are behavior tests for that contract:
identity-gated, non-destructive, and never a path to outbound transmission.
"""

from __future__ import annotations

import pytest

from hermes_cli.config import get_config_path, read_raw_config
from hermes_cli.observability import shared_metrics_consent as consent
from hermes_cli.observability.shared_metrics_send_config import resolve_send_config


@pytest.fixture()
def home(monkeypatch):
    """A per-test isolated home (conftest already sandboxes HERMES_HOME)."""
    monkeypatch.delenv(consent.ENTERPRISE_ENV_VAR, raising=False)
    yield


def _shared_metrics() -> dict:
    cfg = read_raw_config()
    return (cfg.get("telemetry") or {}).get("shared_metrics") or {}


def test_upstream_build_is_untouched(home, monkeypatch):
    """Every upstream variant: the marker is absent, so nothing is read or written."""
    monkeypatch.delenv(consent.ENTERPRISE_ENV_VAR, raising=False)

    assert consent.enterprise_identity() is False
    assert consent.apply_enterprise_consent_default() == "not-enterprise"
    # Undecided stays undecided — the upstream first-run offer still exists.
    assert consent.consent_state(read_raw_config()) == {"enabled": False, "send": False, "decided": False}
    assert _shared_metrics() == {}


def test_enterprise_default_is_local_only_and_never_asks(home, monkeypatch):
    """Enterprise + no explicit answer: local collection, sending off, decided → no offer."""
    monkeypatch.setenv(consent.ENTERPRISE_ENV_VAR, "1")

    assert consent.apply_enterprise_consent_default() == "seeded"

    assert consent.consent_state(read_raw_config()) == {"enabled": True, "send": False, "decided": True}
    # `decided` is exactly the latch the composer strip and the CLI offer read: the question
    # (and with it the "Send to Nous" choice) never appears on any surface.
    assert consent.consent_decided() is True
    # And the transmission policy resolves to collection on, upload off.
    resolved = resolve_send_config(read_raw_config())
    assert resolved.enabled is True
    assert resolved.send is False


def test_enterprise_respects_an_explicit_existing_answer(home, monkeypatch):
    """An operator's explicit setting is never overwritten — even send=True."""
    monkeypatch.setenv(consent.ENTERPRISE_ENV_VAR, "1")
    config_path = get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        "telemetry:\n  shared_metrics:\n    enabled: true\n    send: true\n", encoding="utf-8"
    )

    assert consent.apply_enterprise_consent_default() == "decided"
    assert _shared_metrics() == {"enabled": True, "send": True}

    # A prior "No thanks" is equally respected.
    config_path.write_text(
        "telemetry:\n  shared_metrics:\n    enabled: false\n    send: false\n", encoding="utf-8"
    )
    assert consent.apply_enterprise_consent_default() == "decided"
    assert _shared_metrics() == {"enabled": False, "send": False}


def test_enterprise_default_is_idempotent(home, monkeypatch):
    """A second startup on an already-seeded profile reports the answer, does not rewrite it."""
    monkeypatch.setenv(consent.ENTERPRISE_ENV_VAR, "1")

    assert consent.apply_enterprise_consent_default() == "seeded"
    assert consent.apply_enterprise_consent_default() == "decided"
    assert _shared_metrics() == {"enabled": True, "send": False}


def test_enterprise_seals_the_send_port_even_when_config_says_send_true(home, monkeypatch, caplog):
    """The load-bearing guarantee: on the enterprise build the transmission port is shut
    at the resolver, whatever config.yaml says. A hand-edited `send: true` cannot send."""
    import logging

    from hermes_cli.observability import shared_metrics_send_config as send_cfg

    monkeypatch.setenv(consent.ENTERPRISE_ENV_VAR, "1")
    monkeypatch.setattr(send_cfg, "_warned_enterprise_send", False, raising=False)

    with caplog.at_level(logging.ERROR):
        resolved = resolve_send_config(
            {"telemetry": {"shared_metrics": {"enabled": True, "send": True}}}
        )

    assert resolved.send is False, "enterprise build must never resolve to a send"
    assert resolved.enabled is True, "collection may stay on; only transmission is sealed"
    # Loud, not silent: the override is logged so an operator can see why nothing sends.
    assert any("Enterprise build" in r.getMessage() for r in caplog.records)


def test_enterprise_send_seal_does_not_touch_upstream_builds(home, monkeypatch):
    """With the marker absent, an explicit send: true still resolves to a send — the
    upstream behaviour the enterprise override must not change."""
    monkeypatch.delenv(consent.ENTERPRISE_ENV_VAR, raising=False)

    resolved = resolve_send_config(
        {"telemetry": {"shared_metrics": {"enabled": True, "send": True}}}
    )
    assert resolved.send is True
