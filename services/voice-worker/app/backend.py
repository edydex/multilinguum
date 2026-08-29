from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Protocol


class VoiceBackend(Protocol):
    @property
    def ready(self) -> bool: ...

    @property
    def detail(self) -> str: ...

    async def render(
        self,
        text: str,
        language: str,
        reference_audio: bytes,
        exaggeration: float,
        cfg_weight: float,
    ) -> bytes: ...


class MockBackend:
    @property
    def ready(self) -> bool:
        return True

    @property
    def detail(self) -> str:
        return "Mock backend is active; output is not playable audio."

    async def render(
        self,
        text: str,
        language: str,
        reference_audio: bytes,
        exaggeration: float,
        cfg_weight: float,
    ) -> bytes:
        return f"mock-opus:{language}:{len(reference_audio)}:{exaggeration}:{cfg_weight}:{text}".encode()


class ChatterboxV3Backend:
    def __init__(self, device: str) -> None:
        self.device = device
        self._model = None
        self._lock = asyncio.Lock()
        self._load_error: str | None = None

    @property
    def ready(self) -> bool:
        return self._load_error is None and shutil.which("ffmpeg") is not None

    @property
    def detail(self) -> str:
        if self._load_error:
            return self._load_error
        if not shutil.which("ffmpeg"):
            return "ffmpeg is not installed."
        return f"Chatterbox Multilingual V3 configured for {self.device}; model loads on first render."

    def _load(self):
        if self._model is None:
            try:
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS

                self._model = ChatterboxMultilingualTTS.from_pretrained(
                    device=self.device,
                    t3_model="v3",
                )
            except Exception as error:
                self._load_error = f"Chatterbox load failed: {error}"
                raise
        return self._model

    async def render(
        self,
        text: str,
        language: str,
        reference_audio: bytes,
        exaggeration: float,
        cfg_weight: float,
    ) -> bytes:
        async with self._lock:
            return await asyncio.to_thread(
                self._render_sync,
                text,
                language,
                reference_audio,
                exaggeration,
                cfg_weight,
            )

    def _render_sync(
        self,
        text: str,
        language: str,
        reference_audio: bytes,
        exaggeration: float,
        cfg_weight: float,
    ) -> bytes:
        import soundfile

        model = self._load()
        with tempfile.TemporaryDirectory(prefix="multilinguum-voice-") as directory:
            root = Path(directory)
            reference_path = root / "reference.wav"
            wav_path = root / "rendered.wav"
            pcm_path = root / "rendered.pcm"
            reference_path.write_bytes(reference_audio)
            waveform = model.generate(
                text,
                language_id=language,
                audio_prompt_path=str(reference_path),
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
            )
            soundfile.write(wav_path, waveform.squeeze().detach().cpu().numpy(), model.sr)
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(wav_path),
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    "-f",
                    "s16le",
                    "-c:a",
                    "pcm_s16le",
                    str(pcm_path),
                ],
                check=True,
                timeout=30,
            )
            return pcm_path.read_bytes()


def create_backend(name: str, device: str) -> VoiceBackend:
    if name == "mock":
        return MockBackend()
    if name != "chatterbox":
        raise ValueError(f"Unsupported voice backend: {name}")
    return ChatterboxV3Backend(device)
