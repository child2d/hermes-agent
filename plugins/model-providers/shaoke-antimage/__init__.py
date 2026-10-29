"""Shaoke Antimage provider profile — the company's internal model gateway.

Every shaoke surface reaches models through one New API relay
(``https://anti-mage.shaoke.com/v1``). Registering it here instead of leaving it
as a per-machine ``custom_providers`` entry is what gives it a stable slug, label
and key env var: a profile under ``plugins/model-providers/<name>/`` is admitted
into ``CANONICAL_PROVIDERS`` automatically
(``models_catalog_static.sync_plugin_provider_catalog``) and resolves in
``providers.get_provider`` at the plugin rung, so ``hermes model``, ``/model``,
the desktop picker, ``doctor`` and the credential resolver all know it without
further wiring.

The wire is plain OpenAI chat completions, and the relay enumerates its own model
set at ``GET /v1/models`` — ``fallback_models`` is only the picker's safety net
for when that fetch fails (measured against the live relay on 2026-10-28).
"""

from providers import register_provider
from providers.base import ProviderProfile

shaoke_antimage = ProviderProfile(
    name="shaoke-antimage",
    aliases=("antimage", "anti-mage"),
    display_name="Shaoke Antimage",
    description="Shaoke Antimage — internal gateway (New API relay, OpenAI-compatible)",
    signup_url="https://anti-mage.shaoke.com/",
    # The key is the relay's own `sk-…` token; the base URL override is here so a
    # machine can point at a different gateway without editing this profile.
    env_vars=("SHAOKE_ANTIMAGE_API_KEY", "SHAOKE_ANTIMAGE_BASE_URL"),
    base_url="https://anti-mage.shaoke.com/v1",
    auth_type="api_key",
    default_aux_model="deepseek-v4.1-flash",
    fallback_models=(
        "minimax-m3",
        "deepseek-v4.1-flash",
        "qwen3.7-max",
        "glm-5.3-flash",
        "kimi-k2.7-code",
    ),
)

register_provider(shaoke_antimage)
