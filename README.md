# Multilinguum

Multilinguum is a single-church, service-operator system for low-latency translated audio and captions. A macOS console captures a clean mixer feed, a local or Linux/NVIDIA processor runs independent language channels, and listeners use one public page without accounts.

The current repository is a production-shaped vertical slice, not a service-ready release. The deterministic pipeline, controls, archives, consent gates, applications, Tauri shell, Cloudflare bundle, and LiveKit publisher compile and test locally. Real OpenAI, LiveKit Cloud, NVIDIA, load, and venue checks still require credentials and the target hardware.

## What is implemented

- Tauri 2 and React operator console with input selection, live meter, preflight, Start/Stop, language and voice configuration, channel health/actions, and archive controls.
- 48 kHz mono browser audio worklet and timestamped binary WebSocket capture.
- Fastify processor with one-service locking, authenticated private APIs, isolated channel state, cost warning, five-second fallback chunks, glossary-aware translation, natural TTS, and clone-to-natural fallback.
- Real server-side LiveKit audio tracks plus short-lived, subscribe-only anonymous listener tokens.
- Mobile listener PWA with language selection, Listen/Pause, volume, captions, reconnect state, and AI-voice disclosure.
- Consent-gated Chatterbox Multilingual V3 worker with encrypted samples and immediate revocation.
- SQLite archive index, JSONL transcripts, 48 kHz PCM working tracks, finalized Opus files, SHA-256 integrity metadata, manual retain/delete, and 30-day purge.
- Per-stage latest/p50/p95 latency telemetry with an exportable, integrity-hashed archive report.
- Linux/NVIDIA Docker Compose deployment and a Cloudflare Worker for the stable public page.
- Credential-free RU to EN/RU/ES/UK replay and an ignored authorized 45-second sermon fixture.

## Important status boundary

The working live capture path currently exercises the documented fallback cascade:

1. five seconds of 48 kHz source PCM;
2. file transcription with the configured OpenAI transcription model;
3. glossary-aware text translation through the Responses API;
4. natural TTS or consented Chatterbox V3 rendering;
5. LiveKit publication and local archive output.

The dedicated GPT-Realtime-Translate and GPT-Live-Transcribe adapters remain a compatibility spike because no API project key is available here. They must pass the language and latency matrix before replacing the fallback. See [Implementation status](docs/IMPLEMENTATION_STATUS.md).

## Local development

Requirements:

- Node 24 and pnpm 11
- Rust 1.94 or newer for the Tauri shell
- Python 3.11 on the GPU host
- ffmpeg and yt-dlp for fixtures and archive encoding

Install and verify:

```sh
pnpm install
pnpm check
cargo check --manifest-path apps/operator/src-tauri/Cargo.toml
```

Start the credential-free processor and UIs:

```sh
cp .env.example .env
pnpm --filter @multilinguum/processor dev
pnpm --filter @multilinguum/operator dev
pnpm --filter @multilinguum/listener dev
```

The example development control token is intentionally accepted only for local development. Replace every placeholder before exposing the processor.

Run the complete deterministic service lifecycle:

```sh
node scripts/replay-fixture.mjs
```

It creates a service, locks configuration, emits four caption channels, finalizes an archive, and prints the manifest.

## Private fixture

The repository contains only the authorized sermon URL, clip boundaries, consent note, and expected hash. The audio is ignored.

```sh
scripts/fetch-authorized-fixture.sh
```

Expected WAV SHA-256:

```text
f8bfae7555bbecebb92a43decdb44289867a56a6e43e7443586ea7ac9c6bb0f0
```

## Repository map

- `apps/operator`: macOS console and Tauri shell
- `apps/listener`: anonymous public listener PWA
- `packages/protocol`: stable domain types, runtime schemas, and provider contracts
- `services/processor`: session orchestration, cloud providers, relay, and archives
- `services/voice-worker`: encrypted Chatterbox V3 GPU worker
- `workers/listener-edge`: Cloudflare public edge
- `fixtures`: committed metadata and ignored private media
- `docs`: architecture, operations, security, feasibility, and acceptance gates

## Production secrets

OpenAI, LiveKit, Cloudflare, and archive/voice keys belong only on the processor or hosted Worker. They must never enter either React bundle, browser storage, recordings, transcripts, Git history, or logs. The console stores only a paired control credential.

Codex and ChatGPT subscriptions are development tools, not production API credit. Production calls require a separately billed OpenAI API project and API key.

Use the [OpenAI API setup runbook](docs/OPENAI_SETUP.md) to create a dedicated project and install its key on the GPU processor without exposing it in chat or shell history.

See [Latency measurement](docs/LATENCY_MEASUREMENT.md) for the exact realtime metrics and paid-call strategy.

## License

Copyright 2026 Multilinguum contributors. Licensed under [AGPL-3.0-only](LICENSE).
