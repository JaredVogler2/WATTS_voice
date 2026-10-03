"""Backend tests: catalog integrity, API endpoints, and the guardrails that keep
LLM output inside the standard element catalog. No network or API keys needed:
providers are mocked."""

import json
from types import SimpleNamespace

import pytest

import app as app_module
from server import catalog, config, interpret, llm_anthropic, llm_bcai

# Element names exactly as WATTS Perform Time Study defines them
# (templates/perform_study.html CATALOG) — voice studies must aggregate with
# tap studies, so these must never drift.
WATTS_CATALOG = {
    "Fastener Installation": ["Drilling Hole", "Deburring", "Countersinking", "Installing Rivet",
                              "Installing Hi-Lok", "Installing Bolt", "Torquing Fastener", "Applying Wet Sealant"],
    "Assembly Operations": ["Part Fitting", "Shimming", "Clamping/Fixturing", "Applying Adhesive",
                            "Fay Surface Sealing", "Component Install", "Panel Installation", "Tube/Duct Fitting"],
    "Electrical": ["Wire Routing", "Cable Tie Install", "Connector Mating", "Terminal Crimping",
                   "Wire Marking", "Harness Install", "Continuity Test", "Grounding/Bonding"],
    "Testing": ["Functional Test", "System Test", "Leak Test", "Pressure Test", "Electrical Test",
                "Test Troubleshooting", "Test Setup", "Test Documentation"],
    "Quality": ["Self-Inspection", "Peer Inspection", "QA Buyoff", "Dimensional Check",
                "Torque Verification", "NDI/NDT", "First Article Insp", "Sealant Cure Check"],
    "Support": ["Reading Work Instr", "Paperwork/Stamps", "MES/System Entry", "Tool Calibration",
                "Safety Procedure", "FOD Check", "Area Cleanup", "Shift Handoff"],
    "Material Handling": ["Gathering Parts", "Kit Retrieval", "Tool Retrieval", "Walking/Travel",
                          "Part Staging", "Searching for Parts", "Searching for Tools", "Material Transport"],
    "Delays": ["Waiting for QA", "Waiting for Parts", "Waiting for Tools", "Waiting for Engr",
               "Gathering Tools", "Setting Up Equip", "Equipment Down", "Personal Time"],
    "Rework/Other": ["Rework - Drilling", "Rework - Fastener", "Rework - Sealing", "Rework - Electrical",
                     "Disassembly", "Setup/Positioning", "Training", "Other"],
}
WATTS_TYPE_EXCEPTIONS = {"Continuity Test": "NVAN", "Test Troubleshooting": "NVAW", "Test Setup": "NVAN",
                         "Test Documentation": "NVAN", "Training": "NVAN"}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("LLM_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "BCAI_PAT",
                 "APP_ACCESS_CODE", "STT_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def client():
    return app_module.app.test_client()


# ── Catalog ────────────────────────────────────────────────────────────────
def test_catalog_matches_watts_names_and_types():
    cat = catalog.load_catalog()
    got = {c["name"]: [e["name"] for e in c["elements"]] for c in cat["categories"]}
    assert got == WATTS_CATALOG
    for c in cat["categories"]:
        for e in c["elements"]:
            expected = WATTS_TYPE_EXCEPTIONS.get(e["name"], c["defaultType"])
            assert e["type"] == expected, e["name"]


def test_catalog_ids_unique_and_other_present():
    ids = catalog.element_ids()
    assert len(ids) == len(set(ids)) == 72
    assert catalog.OTHER_ID in ids
    assert catalog.element_index()[catalog.OTHER_ID].get("requiresDescription") is True


def test_aliases_do_not_collide_across_elements():
    seen = {}
    for el in catalog.element_index().values():
        for alias in el.get("aliases", []):
            key = alias.lower()
            assert key not in seen, f"alias '{alias}' used by {seen.get(key)} and {el['id']}"
            seen[key] = el["id"]


def test_catalog_endpoint_preserves_order(client):
    data = client.get("/api/catalog").get_json()
    assert list(data["leanTypes"]) == ["VA", "NVAN", "NVAW", "NVAD"]
    assert data["categories"][0]["code"] == "FAS"


# ── Config / static ────────────────────────────────────────────────────────
def test_index_and_config(client):
    assert client.get("/").status_code == 200
    cfg = client.get("/api/config").get_json()
    assert cfg["llm"] == {"enabled": False, "provider": "none", "model": ""}
    assert cfg["stt"]["enabled"] is False
    assert cfg["accessCodeRequired"] is False


def test_provider_auto_detection(monkeypatch):
    assert config.llm_provider() == "none"
    monkeypatch.setenv("BCAI_PAT", "x")
    assert config.llm_provider() == "bcai"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "y")
    assert config.llm_provider() == "anthropic"
    monkeypatch.setenv("LLM_PROVIDER", "none")
    assert config.llm_provider() == "none"


# ── /api/interpret ─────────────────────────────────────────────────────────
def test_interpret_without_provider_is_503(client):
    r = client.post("/api/interpret", json={"text": "drilling"})
    assert r.status_code == 503
    assert r.get_json()["ok"] is False


def test_interpret_requires_text(client):
    assert client.post("/api/interpret", json={}).status_code == 400


def test_interpret_access_code(client, monkeypatch):
    monkeypatch.setenv("APP_ACCESS_CODE", "s3cret")
    assert client.post("/api/interpret", json={"text": "x"}).status_code == 401
    r = client.post("/api/interpret", json={"text": "x"}, headers={"X-Access-Code": "wrong"})
    assert r.status_code == 401
    r = client.post("/api/interpret", json={"text": "drilling"}, headers={"X-Access-Code": "s3cret"})
    assert r.status_code == 503   # passes the gate; no provider configured


def test_interpret_with_mocked_provider(client, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    seen = {}

    def fake_classify(system, user, schema):
        seen.update(system=system, user=user, schema=schema)
        return {"intent": "element", "element_id": "ASM-05", "confidence": 0.91,
                "alternatives": ["FAS-08", "BOGUS-1", "ASM-05"], "command": "none",
                "other_description": "", "note": "", "rationale": "Generic sealing is fay sealing."}

    monkeypatch.setattr(llm_anthropic, "classify", fake_classify)
    r = client.post("/api/interpret", json={"text": "sealant work", "context": {
        "current_element_id": "FAS-01", "task_description": "Install bulkhead",
        "recent": ["drilling holes"], "speech_alternatives": ["seal and work"]}})
    body = r.get_json()
    assert r.status_code == 200 and body["ok"]
    d = body["decision"]
    assert d["element_id"] == "ASM-05" and d["element"]["name"] == "Fay Surface Sealing"
    assert d["alternatives"] == ["FAS-08"]          # unknown + self removed
    assert d["provider"] == "anthropic"
    assert 'Utterance: "sealant work"' in seen["user"]
    assert "FAS-01 Drilling Hole" in seen["user"]
    assert "Install bulkhead" in seen["user"]
    assert "ASM-05 | Fay Surface Sealing | VA" in seen["system"]
    assert "ASM-05" in seen["schema"]["properties"]["element_id"]["enum"]


# ── normalize_decision guardrails ──────────────────────────────────────────
def test_normalize_rejects_unknown_element():
    d = interpret.normalize_decision({"intent": "element", "element_id": "XYZ-99", "confidence": 0.99})
    assert d["intent"] == "unclear" and d["element_id"] is None


def test_normalize_same_element_uses_current():
    d = interpret.normalize_decision({"intent": "same_element", "element_id": "NONE", "confidence": 0.8},
                                     {"current_element_id": "FAS-07"})
    assert d["intent"] == "same_element" and d["element_id"] == "FAS-07"


def test_normalize_command_and_note():
    d = interpret.normalize_decision({"intent": "command", "command": "photo", "element_id": "FAS-01"})
    assert d["command"] == "photo" and d["element_id"] is None
    d = interpret.normalize_decision({"intent": "command", "command": "dance"})
    assert d["intent"] == "unclear"
    d = interpret.normalize_decision({"intent": "note", "note": "bit looks dull", "element_id": "NONE"})
    assert d["note"] == "bit looks dull" and d["command"] == "none"


def test_normalize_other_description_and_clamping():
    d = interpret.normalize_decision({"intent": "element", "element_id": catalog.OTHER_ID,
                                      "other_description": "  Applying   Speed Tape " + "x" * 80,
                                      "confidence": 7})
    assert d["other_description"].startswith("Applying Speed Tape")
    assert len(d["other_description"]) <= 60
    assert d["confidence"] == 1.0
    d = interpret.normalize_decision({"intent": "element", "element_id": "FAS-01",
                                      "other_description": "ignored", "confidence": "bad"})
    assert d["other_description"] == "" and d["confidence"] == 0.0


def test_normalize_garbage_input():
    assert interpret.normalize_decision(None)["intent"] == "unclear"
    assert interpret.normalize_decision(["x"])["intent"] == "unclear"


def test_parse_json_text_tolerates_fences():
    assert interpret.parse_json_text('```json\n{"intent": "note"}\n```') == {"intent": "note"}
    assert interpret.parse_json_text('Sure! {"a": 1} hope that helps') == {"a": 1}
    with pytest.raises(interpret.ProviderError):
        interpret.parse_json_text("no json here")


def test_system_prompt_is_stable():
    # Byte-stable so the catalog prefix stays cached between utterances.
    assert interpret.system_prompt() == interpret.system_prompt()


# ── Providers (mocked transport) ───────────────────────────────────────────
class FakeMessages:
    def __init__(self, response):
        self.response = response
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        return self.response


def _fake_client(response):
    messages = FakeMessages(response)
    return SimpleNamespace(beta=SimpleNamespace(messages=messages)), messages


def test_anthropic_request_shape(monkeypatch):
    text = json.dumps({"intent": "element", "element_id": "FAS-01"})
    response = SimpleNamespace(stop_reason="end_turn",
                               content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text=text)])
    client, messages = _fake_client(response)
    monkeypatch.setattr(llm_anthropic, "_client", lambda: client)
    out = llm_anthropic.classify("SYS", "USER", {"type": "object"})
    assert out == {"intent": "element", "element_id": "FAS-01"}
    kw = messages.kwargs
    assert kw["model"] == "claude-opus-5-5"
    assert kw["output_config"]["format"] == {"type": "json_schema", "schema": {"type": "object"}}
    assert kw["output_config"]["effort"] == "low"
    assert kw["fallbacks"] == "default" and kw["betas"] == ["server-side-fallback-2026-07-01"]
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert kw["messages"] == [{"role": "user", "content": "USER"}]


def test_anthropic_refusal_raises(monkeypatch):
    client, _ = _fake_client(SimpleNamespace(stop_reason="refusal", content=[]))
    monkeypatch.setattr(llm_anthropic, "_client", lambda: client)
    with pytest.raises(interpret.ProviderError):
        llm_anthropic.classify("S", "U", {})


def test_bcai_provider_parses_reply(monkeypatch):
    monkeypatch.setenv("BCAI_PAT", "pat")
    captured = {}

    class Resp:
        content = (json.dumps({"choices": [{"message": {"content":
                   '```json\n{"intent":"element","element_id":"DLY-01","confidence":0.8}\n```'}}]})).encode()

        def raise_for_status(self):
            pass

    def fake_post(url, headers, json, verify, timeout):
        captured.update(url=url, headers=headers, json=json, verify=verify)
        return Resp()

    monkeypatch.setattr(llm_bcai.requests, "post", fake_post)
    out = llm_bcai.classify("SYS", "USER", {"type": "object"})
    assert out["element_id"] == "DLY-01"
    assert captured["headers"]["Authorization"] == "basic pat"
    assert captured["json"]["messages"][0]["content"].startswith("SYS")
    assert captured["verify"] is True


# ── /api/transcribe ────────────────────────────────────────────────────────
def test_transcribe_not_configured(client):
    import io
    r = client.post("/api/transcribe", data={"audio": (io.BytesIO(b"RIFF...."), "a.wav")},
                    content_type="multipart/form-data")
    assert r.status_code == 503


def test_transcribe_missing_file(client):
    assert client.post("/api/transcribe", data={}, content_type="multipart/form-data").status_code == 400
