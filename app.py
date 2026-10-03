"""WATTS Voice — voice-narrated time studies.

One Flask app serves the browser client (``public/``) and a small JSON API.
The same entrypoint (``app:app``) runs on Vercel, Posit Connect and locally:

    flask --app app run --debug          # local dev on http://127.0.0.1:5000

The browser does the timing, photo capture and storage; the server only
holds the standard element catalog and proxies the LLM / speech-to-text calls
so API keys never reach the device.
"""

import hmac
import logging
import os
from functools import wraps

from flask import Flask, jsonify, request, send_from_directory

from server import config
from server.catalog import load_catalog
from server.interpret import MAX_UTTERANCE_CHARS, ProviderError, interpret
from server.stt import MAX_AUDIO_BYTES, SttError, transcribe

PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("watts_voice")

app = Flask(__name__, static_folder=PUBLIC_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_AUDIO_BYTES + 256 * 1024
# The service worker owns client-side caching; always revalidate app files.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
# Keep catalog order (VA, NVAN, NVAW, NVAD; categories as WATTS lists them).
app.json.sort_keys = False


def require_access_code(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        expected = config.access_code()
        if expected:
            supplied = request.headers.get("X-Access-Code", "")
            if not hmac.compare_digest(supplied.encode(), expected.encode()):
                return jsonify({"ok": False, "error": "Access code required"}), 401
        return view(*args, **kwargs)
    return wrapper


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("Permissions-Policy",
                            "camera=(self), microphone=(self), screen-wake-lock=(self)")
    return resp


@app.get("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.get("/api/health")
def health():
    return jsonify({"ok": True})


@app.get("/api/config")
def client_config():
    """Tells the client which server-side capabilities are available."""
    provider = config.llm_provider()
    model = {"anthropic": config.anthropic_model(),
             "bcai": config.bcai_settings()["model"]}.get(provider, "")
    return jsonify({
        "ok": True,
        "llm": {"enabled": provider != "none", "provider": provider, "model": model},
        "stt": {"enabled": config.stt_enabled(), "model": config.stt_settings()["model"]},
        "accessCodeRequired": bool(config.access_code()),
        "catalogVersion": load_catalog()["version"],
    })


@app.get("/api/catalog")
def catalog():
    return jsonify(load_catalog())


@app.post("/api/interpret")
@require_access_code
def api_interpret():
    body = request.get_json(silent=True) or {}
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"ok": False, "error": "text is required"}), 400
    if len(text) > MAX_UTTERANCE_CHARS * 2:
        return jsonify({"ok": False, "error": "Utterance too long"}), 413
    context = body.get("context") if isinstance(body.get("context"), dict) else {}
    try:
        decision = interpret(text, context)
    except ProviderError as e:
        log.warning("interpret failed: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 503
    return jsonify({"ok": True, "decision": decision})


@app.post("/api/transcribe")
@require_access_code
def api_transcribe():
    upload = request.files.get("audio")
    if upload is None:
        return jsonify({"ok": False, "error": "audio file is required"}), 400
    try:
        text = transcribe(upload.read(), upload.filename, upload.mimetype)
    except SttError as e:
        log.warning("transcribe failed: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 503
    return jsonify({"ok": True, "text": text})


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"ok": False, "error": "Upload too large"}), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=True)
