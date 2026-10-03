"""Environment-driven configuration (Vercel, Posit Connect and local dev all
configure the app through environment variables)."""

import os


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def llm_provider() -> str:
    """Which LLM maps narration to standard elements: anthropic | bcai | none.

    ``LLM_PROVIDER=auto`` (the default) picks the first provider that has
    credentials configured.
    """
    choice = _env("LLM_PROVIDER", "auto").lower()
    if choice in ("anthropic", "bcai", "none"):
        return choice
    if _env("ANTHROPIC_API_KEY") or _env("ANTHROPIC_AUTH_TOKEN"):
        return "anthropic"
    if _env("BCAI_PAT"):
        return "bcai"
    return "none"


def anthropic_model() -> str:
    return _env("ANTHROPIC_MODEL", "claude-opus-5-5")


def anthropic_effort() -> str:
    effort = _env("ANTHROPIC_EFFORT", "low").lower()
    return effort if effort in ("low", "medium", "high", "xhigh", "max") else "low"


def bcai_settings() -> dict:
    return {
        "url": _env("BCAI_API_URL", "https://boeingai-test.web.boeing.com/bcai-public-api/conversation"),
        "model": _env("BCAI_MODEL", "gpt-5.4-mini"),
        "pat": _env("BCAI_PAT"),
        "use_case_id": _env("BCAI_USE_CASE_ID", "bcai-use-case.design-practices"),
        # Boeing's internal endpoints use the enterprise CA; point this at the
        # bundle (or "false" only on a trusted network, as WATTS does).
        "verify": _env("BCAI_CA_BUNDLE", "true"),
    }


def stt_settings() -> dict:
    """Server-side speech-to-text (OpenAI-compatible /audio/transcriptions).

    Used by browsers without the Web Speech API (Firefox) and by the
    "server transcription" engine option.
    """
    return {
        "api_key": _env("STT_API_KEY") or _env("OPENAI_API_KEY"),
        "base_url": _env("STT_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
        "model": _env("STT_MODEL", "gpt-4o-mini-transcribe"),
        "language": _env("STT_LANGUAGE", "en"),
    }


def stt_enabled() -> bool:
    return bool(stt_settings()["api_key"])


def access_code() -> str:
    """Optional shared code required on the LLM / STT proxy endpoints so a
    public deployment (e.g. Vercel) can't be used as an open LLM relay."""
    return _env("APP_ACCESS_CODE")
