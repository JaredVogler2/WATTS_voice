"""Claude provider: structured JSON output constrained to the catalog codes."""

import json
import logging
from functools import lru_cache

import anthropic

from . import config
from .interpret import ProviderError

log = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _client() -> anthropic.Anthropic:
    # One short retry: the analyst is waiting on the mapping, and the browser
    # already shows its local best guess while this runs.
    return anthropic.Anthropic(timeout=25.0, max_retries=1)


def classify(system_prompt: str, user_prompt: str, schema: dict) -> dict:
    try:
        response = _client().beta.messages.create(
            model=config.anthropic_model(),
            max_tokens=2048,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            # The system prompt carries the whole catalog and never changes
            # between requests, so it is cached across utterances.
            system=[{"type": "text", "text": system_prompt,
                     "cache_control": {"type": "ephemeral"}}],
            output_config={
                "effort": config.anthropic_effort(),
                "format": {"type": "json_schema", "schema": schema},
            },
            messages=[{"role": "user", "content": user_prompt}],
        )
    except anthropic.RateLimitError as e:
        raise ProviderError("Claude rate limit reached") from e
    except anthropic.AuthenticationError as e:
        raise ProviderError("Claude API key rejected") from e
    except anthropic.BadRequestError as e:
        log.error("Claude bad request: %s", e.message)
        raise ProviderError("Claude rejected the request") from e
    except anthropic.APIStatusError as e:
        raise ProviderError(f"Claude API error {e.status_code}") from e
    except anthropic.APIConnectionError as e:
        raise ProviderError("Could not reach the Claude API") from e

    if response.stop_reason == "refusal":
        raise ProviderError("Claude declined to classify this utterance")
    if response.stop_reason == "max_tokens":
        raise ProviderError("Claude response was truncated")

    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise ProviderError("Claude returned invalid JSON") from e
