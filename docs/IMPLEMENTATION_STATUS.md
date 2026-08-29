# Implementation status

This document distinguishes implemented code from claims that require external systems.

## Locally verified

- Shared schemas and provider boundaries compile.
- Two-hour, three-target cloud estimate is $14.28 under the plan's published per-minute baseline.
- Processor create, lock, replay, channel action, stop, and archive lifecycle tests pass.
- Authenticated archive transcript export and per-track playback routes are covered by the processor tests; the operator exposes both alongside retain/delete.
- Unauthorized private preflight is rejected.
- Consent is required before profile installation.
- Reference samples are not stored in plaintext.
- Revocation deletes the worker sample and blocks subsequent rendering.
- Operator and listener production bundles build.
- Cloudflare Worker dry-run reads the listener bundle.
- Tauri/Rust shell compile-checks on macOS.
- The private fixture is 45.000 seconds, 48 kHz mono PCM and matches the committed SHA-256.

## Implemented but not externally verified

- OpenAI file transcription, Responses translation, and natural speech requests.
- Chatterbox Multilingual V3 CUDA model loading and synthesis.
- LiveKit server-side track connection, publication, and listener subscription.
- Cloudflare deployment and stable public hostname.
- Linux/NVIDIA Docker images and GPU reservation.
- Remote capture through a TLS reverse proxy.

These paths require real credentials, network services, and/or the Linux GPU host.

## Still to implement

- Direct GPT-Realtime-Translate channel adapter.
- GPT-Live-Transcribe streaming source adapter.
- Compatibility results for every RU/EN to EN/RU/ES/UK combination.
- Automatic Piper Ukrainian fallback.
- mDNS discovery, one-time pairing completion, client certificate issuance, and stored server fingerprint verification. The current pairing offer is explicitly marked bootstrap-only.
- Voice-profile sample upload UI and processor-to-worker installation call.
- Listener counts fed back from LiveKit into `ChannelHealth`.
- Provider reconnect/resume logic for active Realtime sessions.
- Local faster-whisper and TranslateGemma provider implementations.
- Signed macOS packages and update distribution.

## Release gates

Do not describe the system as service-ready until all checks in [Acceptance](ACCEPTANCE.md) pass on the actual church mixer, MacBook Air, Linux/NVIDIA server, LiveKit plan, public hostname, and representative phones.
