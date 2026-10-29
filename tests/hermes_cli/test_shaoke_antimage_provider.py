"""Focused tests for the Shaoke Antimage first-class provider.

These pin the wiring that makes the internal gateway a real provider — alias
resolution through both CLI resolvers, admission into ``CANONICAL_PROVIDERS``,
its row in the desktop catalog (API-keys tab), the dashboard key registry and
credential/base-URL resolution — without any live network call.
"""

from __future__ import annotations

import sys
import types

import pytest

if "dotenv" not in sys.modules:
    fake_dotenv = types.ModuleType("dotenv")
    fake_dotenv.load_dotenv = lambda *args, **kwargs: None
    sys.modules["dotenv"] = fake_dotenv

SLUG = "shaoke-antimage"
KEY_ENV = "SHAOKE_ANTIMAGE_API_KEY"
BASE_URL = "https://anti-mage.shaoke.com/v1"


@pytest.fixture(autouse=True)
def _clear_provider_env(monkeypatch):
    for key in (KEY_ENV, "SHAOKE_ANTIMAGE_BASE_URL"):
        monkeypatch.delenv(key, raising=False)


class TestShaokeAntimageAliases:
    """Both CLI resolvers must map the aliases — the plugin's ``aliases=`` tuple is
    NOT consulted by these static maps, so they need explicit coverage."""

    @pytest.mark.parametrize("alias", ["antimage", "anti-mage", "shaoke", "Anti-Mage", " antimage "])
    def test_models_normalize_provider(self, alias):
        from hermes_cli.models import normalize_provider

        assert normalize_provider(alias) == SLUG

    @pytest.mark.parametrize("alias", ["antimage", "anti-mage", "shaoke"])
    def test_providers_normalize_provider(self, alias):
        from hermes_cli.providers import normalize_provider as normalize_in_providers

        assert normalize_in_providers(alias) == SLUG


class TestShaokeAntimageCatalog:
    def test_admitted_into_canonical_providers(self):
        from hermes_cli.models import CANONICAL_PROVIDERS

        by_slug = {p.slug: p for p in CANONICAL_PROVIDERS}
        assert SLUG in by_slug, "plugin provider did not reach CANONICAL_PROVIDERS"
        assert by_slug[SLUG].label == "Shaoke Antimage"
        assert by_slug[SLUG].tui_desc, "canonical row needs a non-empty description"

    def test_catalog_row_lands_on_the_keys_tab(self):
        from hermes_cli.provider_catalog import provider_catalog

        row = next((d for d in provider_catalog() if d.slug == SLUG), None)
        assert row is not None, "provider missing from the desktop catalog"
        assert row.tab == "keys", "an api_key provider is configured on the keys tab"
        assert row.auth_type == "api_key"
        assert KEY_ENV in row.api_key_env_vars, "the profile's env var must reach the catalog"

    def test_resolves_to_the_gateway_endpoint(self):
        from hermes_cli.providers import get_provider

        pdef = get_provider(SLUG)
        assert pdef is not None, "plugin profile with a concrete endpoint must resolve"
        assert pdef.base_url == BASE_URL


class TestShaokeAntimageCredentials:
    def test_optional_env_vars_include_the_key(self):
        from hermes_cli.config import OPTIONAL_ENV_VARS

        assert KEY_ENV in OPTIONAL_ENV_VARS
        assert OPTIONAL_ENV_VARS[KEY_ENV]["category"] == "provider"
        assert OPTIONAL_ENV_VARS[KEY_ENV]["password"] is True

    def test_resolves_key_and_default_base_url(self, monkeypatch):
        from hermes_cli.auth import resolve_api_key_provider_credentials

        monkeypatch.setenv(KEY_ENV, "sk-antimage-test")
        creds = resolve_api_key_provider_credentials(SLUG)
        assert creds["api_key"] == "sk-antimage-test"
        assert creds["base_url"] == BASE_URL

    def test_base_url_override_is_honoured(self, monkeypatch):
        from hermes_cli.auth import resolve_api_key_provider_credentials

        monkeypatch.setenv(KEY_ENV, "sk-antimage-test")
        monkeypatch.setenv("SHAOKE_ANTIMAGE_BASE_URL", "https://gateway.test/v1")
        creds = resolve_api_key_provider_credentials(SLUG)
        assert creds["base_url"] == "https://gateway.test/v1"
