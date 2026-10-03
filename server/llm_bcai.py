"""Boeing BCAI provider — same conversation endpoint/auth pattern WATTS uses
(``bcai_client.py``). For deployments inside the Boeing network (e.g. an
internal Posit Connect server) where external LLM APIs are not approved."""

import json
import logging
import time

import requests

from . import config
from .interpret import ProviderError, parse_json_text

log = logging.getLogger(__name__)


def classify(system_prompt: str, user_prompt: str, schema: dict) -> dict:
    settings = config.bcai_settings()
    if not settings["pat"]:
        raise ProviderError("BCAI_PAT is not configured")

    # BCAI has no schema-constrained output, so the schema rides in the prompt
    # and normalize_decision() enforces it afterwards.
    system = (system_prompt + "\n\nRespond with only a JSON object matching this JSON schema:\n"
              + json.dumps(schema, separators=(",", ":")))
    verify = settings["verify"]
    if verify.lower() in ("true", "1", "yes", ""):
        verify = True
    elif verify.lower() in ("false", "0", "no"):
        verify = False

    payload = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_prompt},
        ],
        "conversation_mode": ["default"],
        "model": settings["model"],
        "conversation_guid": f"watts_voice_{int(time.time() * 1000)}",
        "stream": "false",
        "conversation_source": "bcai-api-system-identifier",
        "use_case_id": settings["use_case_id"],
        "info_types": ["earn"],
    }
    headers = {
        "accept": "application/json",
        "Authorization": f"basic {settings['pat']}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(settings["url"], headers=headers, json=payload,
                             verify=verify, timeout=30)
        resp.raise_for_status()
        last_line = resp.content.decode("utf-8").strip().split("\n")[-1]
        text = json.loads(last_line)["choices"][0]["message"]["content"]
    except requests.RequestException as e:
        raise ProviderError(f"BCAI request failed: {e}") from e
    except (ValueError, KeyError, IndexError) as e:
        raise ProviderError(f"Unexpected BCAI response: {e}") from e
    return parse_json_text(text)
