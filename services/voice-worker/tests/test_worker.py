import hashlib
import os
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

os.environ.setdefault("MULTILINGUUM_VOICE_BACKEND", "mock")
os.environ.setdefault("VOICE_PROFILE_ROOT", str(Path(tempfile.gettempdir()) / "multilinguum-test-voices"))

from app.config import Settings
from app.main import create_app


TOKEN = "test-worker-token-with-sufficient-length"
PROFILE_ID = "3b75a4bf-b3df-4a0f-97a8-87a8a842b4af"


def client(tmp_path: Path) -> TestClient:
    settings = Settings(
        profile_root=tmp_path,
        profile_key=b"1" * 32,
        worker_token=TOKEN,
        backend="mock",
        device="cpu",
    )
    return TestClient(create_app(settings))


def test_consent_gate_and_revocation(tmp_path: Path) -> None:
    api = client(tmp_path)
    sample = b"RIFF-authorized-reference-audio"
    digest = hashlib.sha256(sample).hexdigest()
    unauthorized = api.put(
        f"/v1/profiles/{PROFILE_ID}/sample",
        files={"sample": ("sample.wav", sample, "audio/wav")},
        headers={"x-sample-sha256": digest, "x-consent-active": "true"},
    )
    assert unauthorized.status_code == 401

    installed = api.put(
        f"/v1/profiles/{PROFILE_ID}/sample",
        files={"sample": ("sample.wav", sample, "audio/wav")},
        headers={
            "authorization": f"Bearer {TOKEN}",
            "x-sample-sha256": digest,
            "x-consent-active": "true",
        },
    )
    assert installed.status_code == 200
    assert not sample in (tmp_path / f"{PROFILE_ID}.sample.enc").read_bytes()

    rendered = api.post(
        "/v1/render",
        headers={"authorization": f"Bearer {TOKEN}"},
        json={
            "text": "Grace and peace to you.",
            "language": "en",
            "profileId": PROFILE_ID,
            "sourceStartMs": 0,
            "sourceEndMs": 1500,
            "sequence": 0,
        },
    )
    assert rendered.status_code == 200
    assert rendered.headers["x-ai-generated"] == "true"

    revoked = api.delete(
        f"/v1/profiles/{PROFILE_ID}",
        headers={"authorization": f"Bearer {TOKEN}"},
    )
    assert revoked.status_code == 204
    denied = api.post(
        "/v1/render",
        headers={"authorization": f"Bearer {TOKEN}"},
        json={
            "text": "Grace and peace to you.",
            "language": "en",
            "profileId": PROFILE_ID,
            "sourceStartMs": 0,
            "sourceEndMs": 1500,
            "sequence": 1,
        },
    )
    assert denied.status_code == 404
