from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    profile_root: Path
    profile_key: bytes
    worker_token: str
    backend: str
    device: str


def load_settings() -> Settings:
    encoded_key = os.environ.get("VOICE_PROFILE_KEY", "")
    if encoded_key:
        key = base64.urlsafe_b64decode(encoded_key)
    elif os.environ.get("MULTILINGUUM_VOICE_BACKEND", "chatterbox") == "mock":
        key = b"0" * 32
    else:
        raise RuntimeError("VOICE_PROFILE_KEY must be a URL-safe base64 encoded 32-byte key.")
    if len(key) != 32:
        raise RuntimeError("VOICE_PROFILE_KEY must decode to exactly 32 bytes.")
    token = os.environ.get("VOICE_WORKER_TOKEN", "development-voice-token-change-me")
    if os.environ.get("ENVIRONMENT") == "production" and "change-me" in token:
        raise RuntimeError("VOICE_WORKER_TOKEN must be replaced in production.")
    return Settings(
        profile_root=Path(os.environ.get("VOICE_PROFILE_ROOT", "/var/lib/multilinguum/voices")),
        profile_key=key,
        worker_token=token,
        backend=os.environ.get("MULTILINGUUM_VOICE_BACKEND", "chatterbox"),
        device=os.environ.get("CHATTERBOX_DEVICE", "cuda"),
    )
