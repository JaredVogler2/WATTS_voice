"""Map one narrated utterance to a standard element (or a note / app command).

Every provider's answer goes through ``normalize_decision`` so that only codes
that exist in the catalog can ever reach the study record.
"""

from __future__ import annotations

import json
import logging
import re

from . import config
from .catalog import OTHER_ID, element_index, element_ids, prompt_listing

log = logging.getLogger(__name__)

INTENTS = ("element", "same_element", "note", "command", "unclear")
COMMANDS = ("none", "pause", "resume", "undo", "photo", "complete")
MAX_UTTERANCE_CHARS = 500


class ProviderError(Exception):
    """The LLM call failed; the client falls back to its local matcher."""


def decision_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "intent": {"type": "string", "enum": list(INTENTS)},
            "element_id": {"type": "string", "enum": element_ids() + ["NONE"]},
            "confidence": {"type": "number"},
            "alternatives": {"type": "array", "items": {"type": "string", "enum": element_ids()}},
            "command": {"type": "string", "enum": list(COMMANDS)},
            "other_description": {"type": "string"},
            "note": {"type": "string"},
            "rationale": {"type": "string"},
        },
        "required": ["intent", "element_id", "confidence", "alternatives", "command",
                     "other_description", "note", "rationale"],
        "additionalProperties": False,
    }


def system_prompt() -> str:
    # Kept byte-stable (no timestamps / per-request data) so it can be cached.
    return f"""You are the interpreter inside WATTS Voice, a time-study app used by industrial engineers on an aircraft final-assembly floor. An analyst watches a mechanic and narrates out loud what the mechanic is doing. Each request gives you one narrated utterance (speech-to-text output, which can contain recognition errors) plus context. Classify it and map it to the standard element catalog below.

The catalog is a controlled vocabulary: studies are compared and aggregated by element code later, so the same activity must always get the same code regardless of how it was phrased ("sealing", "sealant work" and "applying sealant" are all ASM-05 unless the narration says the sealant is going on fasteners (FAS-08), is being redone (RWK-03), or is being inspected for cure (QUA-08)).

Intents:
- element: the mechanic is now doing an activity (a new one or a restatement). element_id is the code for what the mechanic is doing NOW; if several actions are mentioned, use the last one ("finished drilling, now deburring" -> FAS-02).
- same_element: the utterance only says the current activity continues ("still going", "next hole", "another one"). Return the current element's code.
- note: commentary that does not change what the mechanic is doing ("this is the third bracket", "bit looks dull"). element_id is NONE; put a cleaned-up note in note.
- command: the analyst is talking to the app rather than describing work: pause, resume, undo / scratch that, take a photo, complete / end the study. Set command; element_id is NONE.
- unclear: you cannot tell what is happening. element_id is NONE.

Mapping rules:
- Treat recognition errors phonetically: "high lock"/"hi lock" = Hi-Lok, "fae"/"fey" surface = fay surface, "debar" = deburr, "clecko" = cleco, "cree" / "creek" crimp = crimp.
- Waiting / idle because something or someone is missing is a Delay (DLY-*). Looking for something is Searching (MAT-06/MAT-07). Going to get something is Retrieval or Walking.
- Use a Rework element only when the narration says work is being redone, removed or fixed.
- Use {OTHER_ID} (Other) only when no element fits; then other_description is a 2-5 word Title Case description of the activity. Otherwise other_description is "".
- confidence is your probability (0 to 1) that element_id is right. alternatives lists up to 3 other plausible codes, best first (empty if none).
- rationale is one short sentence.
- command is "none" unless intent is command. note is "" unless intent is note.

Standard element catalog (code | name | lean type | phrasings):
{prompt_listing()}"""


def user_prompt(text: str, context: dict) -> str:
    current = context.get("current_element_id") or ""
    idx = element_index()
    lines = [f'Utterance: "{text}"']
    if current in idx:
        el = idx[current]
        lines.append(f"Current element: {current} {el['name']} ({el['type']})")
    else:
        lines.append("Current element: none (study just started or nothing mapped yet)")
    task = (context.get("task_description") or "").strip()
    if task:
        lines.append(f"Job being studied: {task[:200]}")
    alts = [a for a in (context.get("speech_alternatives") or []) if isinstance(a, str) and a.strip()]
    if alts:
        lines.append("Other speech-recognition hypotheses: " + " | ".join(a[:120] for a in alts[:3]))
    recent = [r for r in (context.get("recent") or []) if isinstance(r, str) and r.strip()]
    if recent:
        lines.append("Recent narration (oldest first):")
        lines.extend(f"- {r[:160]}" for r in recent[-4:])
    return "\n".join(lines)


def normalize_decision(raw, context: dict | None = None) -> dict:
    """Coerce a provider's answer into a safe, catalog-valid decision."""
    context = context or {}
    idx = element_index()
    if not isinstance(raw, dict):
        raw = {}

    intent = raw.get("intent") if raw.get("intent") in INTENTS else "unclear"
    element_id = raw.get("element_id") if isinstance(raw.get("element_id"), str) else "NONE"
    command = raw.get("command") if raw.get("command") in COMMANDS else "none"
    current = context.get("current_element_id")

    try:
        confidence = float(raw.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    if intent == "same_element":
        if current in idx:
            element_id = current
        elif element_id in idx:
            intent = "element"
        else:
            intent, element_id = "unclear", "NONE"
    elif intent == "element":
        if element_id not in idx:
            intent, element_id = "unclear", "NONE"
    else:
        element_id = "NONE"

    if intent == "command" and command == "none":
        intent = "unclear"
    if intent != "command":
        command = "none"

    alternatives = []
    for alt in raw.get("alternatives") or []:
        if alt in idx and alt != element_id and alt not in alternatives:
            alternatives.append(alt)
    alternatives = alternatives[:3]

    other = ""
    if element_id == OTHER_ID:
        other = re.sub(r"\s+", " ", str(raw.get("other_description") or "")).strip()[:60]

    note = str(raw.get("note") or "").strip()[:300] if intent == "note" else ""

    decision = {
        "intent": intent,
        "element_id": element_id if element_id in idx else None,
        "confidence": round(confidence, 3),
        "alternatives": alternatives,
        "command": command,
        "other_description": other,
        "note": note,
        "rationale": str(raw.get("rationale") or "").strip()[:240],
    }
    if decision["element_id"]:
        el = idx[decision["element_id"]]
        decision["element"] = {"id": el["id"], "name": el["name"], "type": el["type"],
                               "category": el["category"]}
    return decision


def parse_json_text(text: str) -> dict:
    """Extract a JSON object from model text (tolerates ```json fences)."""
    text = (text or "").strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ProviderError("Model did not return JSON")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise ProviderError(f"Model returned invalid JSON: {e}") from e


def interpret(text: str, context: dict | None = None) -> dict:
    context = context or {}
    text = re.sub(r"\s+", " ", (text or "")).strip()[:MAX_UTTERANCE_CHARS]
    if not text:
        raise ValueError("Empty utterance")

    provider = config.llm_provider()
    if provider == "anthropic":
        from .llm_anthropic import classify
    elif provider == "bcai":
        from .llm_bcai import classify
    else:
        raise ProviderError("No LLM provider configured")

    raw = classify(system_prompt(), user_prompt(text, context), decision_schema())
    decision = normalize_decision(raw, context)
    decision["provider"] = provider
    return decision
