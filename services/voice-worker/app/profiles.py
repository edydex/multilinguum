from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


SAFE_ID = re.compile(r"^[a-f0-9-]{36}$")


class EncryptedProfileStore:
    def __init__(self, root: Path, key: bytes) -> None:
        self.root = root.resolve()
        self.cipher = AESGCM(key)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def install(self, profile_id: str, sample: bytes, expected_sha256: str) -> str:
        self._validate_id(profile_id)
        actual = hashlib.sha256(sample).hexdigest()
        if actual != expected_sha256:
            raise ValueError("Voice sample hash does not match the consented profile metadata.")
        nonce = os.urandom(12)
        encrypted = nonce + self.cipher.encrypt(nonce, sample, profile_id.encode())
        destination = self.root / f"{profile_id}.sample.enc"
        temporary = destination.with_suffix(".tmp")
        temporary.write_bytes(encrypted)
        temporary.chmod(0o600)
        temporary.replace(destination)
        return actual

    def read(self, profile_id: str) -> bytes:
        self._validate_id(profile_id)
        encrypted = (self.root / f"{profile_id}.sample.enc").read_bytes()
        return self.cipher.decrypt(encrypted[:12], encrypted[12:], profile_id.encode())

    def revoke(self, profile_id: str) -> None:
        self._validate_id(profile_id)
        (self.root / f"{profile_id}.sample.enc").unlink(missing_ok=True)

    def exists(self, profile_id: str) -> bool:
        self._validate_id(profile_id)
        return (self.root / f"{profile_id}.sample.enc").is_file()

    @staticmethod
    def _validate_id(profile_id: str) -> None:
        if not SAFE_ID.fullmatch(profile_id):
            raise ValueError("Invalid profile identifier.")
