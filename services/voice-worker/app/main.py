from __future__ import annotations

import hmac

from fastapi import Depends, FastAPI, Header, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from .backend import create_backend
from .config import Settings, load_settings
from .profiles import EncryptedProfileStore


class RenderRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    language: str = Field(pattern=r"^(en|ru|es)$")
    profileId: str = Field(pattern=r"^[a-f0-9-]{36}$")
    sourceStartMs: int = Field(ge=0)
    sourceEndMs: int = Field(gt=0)
    sequence: int = Field(ge=0)
    exaggeration: float = Field(default=0.5, ge=0.0, le=1.0)
    cfgWeight: float = Field(default=0.35, ge=0.0, le=1.0)


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or load_settings()
    store = EncryptedProfileStore(active_settings.profile_root, active_settings.profile_key)
    backend = create_backend(active_settings.backend, active_settings.device)
    app = FastAPI(title="Multilinguum Voice Worker", version="0.1.0")

    def authorize(authorization: str = Header(default="")) -> None:
        prefix = "Bearer "
        token = authorization[len(prefix) :] if authorization.startswith(prefix) else ""
        if not hmac.compare_digest(token, active_settings.worker_token):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {
            "status": "ok" if backend.ready else "degraded",
            "backend": active_settings.backend,
            "device": active_settings.device,
            "ready": backend.ready,
            "detail": backend.detail,
        }

    @app.put("/v1/profiles/{profile_id}/sample", dependencies=[Depends(authorize)])
    async def install_profile(
        profile_id: str,
        sample: UploadFile,
        x_sample_sha256: str = Header(),
        x_consent_active: str = Header(),
    ) -> dict[str, str]:
        if x_consent_active.lower() != "true":
            raise HTTPException(status_code=409, detail="Active consent is required.")
        contents = await sample.read()
        if len(contents) > 25 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Voice sample is too large.")
        try:
            digest = store.install(profile_id, contents, x_sample_sha256)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"profileId": profile_id, "sha256": digest, "status": "installed"}

    @app.delete("/v1/profiles/{profile_id}", dependencies=[Depends(authorize)])
    async def revoke_profile(profile_id: str) -> Response:
        try:
            store.revoke(profile_id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return Response(status_code=204)

    @app.post("/v1/render", dependencies=[Depends(authorize)])
    async def render(request: RenderRequest) -> Response:
        if not store.exists(request.profileId):
            raise HTTPException(status_code=404, detail="Voice profile is not installed or was revoked.")
        try:
            audio = await backend.render(
                request.text,
                request.language,
                store.read(request.profileId),
                request.exaggeration,
                request.cfgWeight,
            )
        except Exception as error:
            raise HTTPException(status_code=503, detail=f"Voice render failed: {error}") from error
        return Response(
            audio,
            media_type="application/octet-stream",
            headers={
                "x-renderer": "chatterbox-multilingual-v3",
                "x-ai-generated": "true",
                "cache-control": "no-store",
            },
        )

    return app


app = create_app()
