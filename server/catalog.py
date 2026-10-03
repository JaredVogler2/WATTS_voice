"""Standard element catalog — the single source of truth for element codes.

The browser fetches it from ``/api/catalog`` and the LLM is constrained to the
codes defined here, so every narrated action lands on exactly one standardized
element (no "sealing" vs "sealant work" drift between studies).
"""

import json
import os
from functools import lru_cache

CATALOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.json")

OTHER_ID = "RWK-08"
LEAN_TYPES = ("VA", "NVAN", "NVAW", "NVAD")


@lru_cache(maxsize=1)
def load_catalog() -> dict:
    with open(CATALOG_PATH, encoding="utf-8") as f:
        catalog = json.load(f)
    _validate(catalog)
    return catalog


def _validate(catalog: dict) -> None:
    seen = set()
    for cat in catalog["categories"]:
        for el in cat["elements"]:
            if el["id"] in seen:
                raise ValueError(f"Duplicate element id {el['id']}")
            if el["type"] not in LEAN_TYPES:
                raise ValueError(f"{el['id']}: unknown lean type {el['type']}")
            seen.add(el["id"])
    if OTHER_ID not in seen:
        raise ValueError(f"Catalog must define the '{OTHER_ID}' (Other) element")


@lru_cache(maxsize=1)
def element_index() -> dict:
    """``{element_id: {id, name, type, category, categoryCode, aliases, ...}}``."""
    index = {}
    for cat in load_catalog()["categories"]:
        for el in cat["elements"]:
            index[el["id"]] = {**el, "category": cat["name"], "categoryCode": cat["code"]}
    return index


def element_ids() -> list:
    return list(element_index().keys())


def prompt_listing() -> str:
    """Compact, deterministic catalog listing for the LLM system prompt."""
    lines = []
    for cat in load_catalog()["categories"]:
        lines.append(f"## {cat['name']} ({cat['code']})")
        for el in cat["elements"]:
            aliases = ", ".join(el.get("aliases") or [])
            extra = " [use only when nothing else fits; put a short description in other_description]" \
                if el.get("requiresDescription") else ""
            lines.append(f"- {el['id']} | {el['name']} | {el['type']}"
                         + (f" | also called: {aliases}" if aliases else "") + extra)
    return "\n".join(lines)


def vocabulary_hint(max_chars: int = 900) -> str:
    """Shop-floor vocabulary used to bias speech-to-text toward catalog terms."""
    words = []
    for el in element_index().values():
        words.append(el["name"])
    hint = "Aircraft assembly time study narration. Terms: " + ", ".join(words)
    return hint[:max_chars]
