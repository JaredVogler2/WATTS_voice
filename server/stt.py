"""Server-side speech-to-text through an OpenAI-compatible transcription API.

Browsers with the Web Speech API (Safari, Chrome, Edge) transcribe on their
own; this path serves Firefox and the optional "server transcription" engine.
"""

import requests

from . import config
from .catalog import vocabulary_hint

MAX_AUDIO_BYTES = 4 * 1024 * 1024  # stays under Vercel's 4.5 MB request cap


class SttError(Exception):
    pass


def transcribe(audio: bytes, filename: str, mimetype: str) -> str:
    settings = config.stt_settings()
    if not settings["api_key"]:
        raise SttError("Server transcription is not configured")
    if not audio:
        raise SttError("Empty audio")
    if len(audio) > MAX_AUDIO_BYTES:
        raise SttError("Audio clip too long")

    try:
        resp = requests.post(
            f"{settings['base_url']}/audio/transcriptions",
            headers={"Authorization": f"Bearer {settings['api_key']}"},
            files={"file": (filename or "speech.wav", audio, mimetype or "audio/wav")},
            data={
                "model": settings["model"],
                "language": settings["language"],
                "response_format": "json",
                # Biases recognition toward catalog terms (Hi-Lok, cleco, fay...).
                "prompt": vocabulary_hint(),
            },
            timeout=30,
        )
    except requests.RequestException as e:
        raise SttError(f"Transcription request failed: {e}") from e
    if resp.status_code >= 400:
        raise SttError(f"Transcription service returned {resp.status_code}")
    try:
        return (resp.json().get("text") or "").strip()
    except ValueError as e:
        raise SttError("Transcription service returned invalid JSON") from e
