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
- Per-segment capture, transcription, translation, voice, relay, and end-to-end timings are separated, summarized as latest/p50/p95, shown in the operator, and stored in an integrity-hashed JSONL report.
- A paid synthetic RU to EN streaming benchmark exercised `gpt-live-transcribe` and `gpt-realtime-translate` concurrently with stage timing and retained audio/report evidence.
- A glossary-aware `gpt-5.6-terra` benchmark corrected both meaning-sensitive errors observed in direct realtime output; its 117 input and 42 output tokens were verified in the dashboard as complimentary data-sharing incentive traffic with $0 model cost.
- The live capture route now owns one shared GPT-Live-Transcribe session plus one GPT-Realtime-Translate session per active natural-voice target. Provider events are normalized behind shared contracts, 48 kHz capture is converted to 24 kHz API audio, returned PCM is converted back to the 48 kHz relay/archive format, and replay tests cover source VAD timing, transcript clauses, audio, and per-channel fallback isolation.
- The operator exposes product-facing **Generic · Fast**, **Generic · Expressive**, and named consented-voice modes. Expressive is the glossary-aware accuracy default; cloned voice is locked to finalized glossary-aware clauses. **Add cloned voice…** records consent, hashes and uploads the reference, and marks the profile ready only after encrypted worker installation. Both generic paths retain the conservative two-hour cloud estimate until measured cascade cost replaces the planning baseline.
- An authorized 45-second actual-sermon rehearsal exercised the integrated private-production capture, transcription, Terra, cloned/natural fallback, timing, and archive path. It proved the pipeline and fallback behavior, but fixed four-second transcription commits split words and clauses and therefore failed the sermon-accuracy gate. A separate coherent quality reference completed transcription, translation, and five sentence-sized Chatterbox renders with independently verified complete speech. See [the authorized sermon benchmark](benchmarks/2026-08-29-authorized-sermon-ru-en.md).

## Implemented but not externally verified

- LiveKit server-side track connection, publication, and listener subscription.
- Cloudflare deployment and stable public hostname.
- Remote capture through a TLS reverse proxy.

These paths still require real credentials, network services, or public ingress.

The standalone paid benchmark harness is externally verified and its normalized adapters are wired into the production capture route. That integrated route has replay coverage but has not yet had its short paid live rehearsal, relay/browser playout measurement, or reconnect test. See [the 2026-08-29 benchmark report](benchmarks/2026-08-29-openai-ru-en.md) for measured timings, cost, retained hashes, and the direct translator's accuracy failure.

## Verified on the Linux/NVIDIA node

The `vr-mayos` SSH target resolves to the throwaway `video-redactor-gpu` Debian host. On 2026-08-29, the checked-out repository, processor, and CUDA voice worker were verified clean and healthy on an RTX 5060 Ti with 16 GB VRAM.

- The worker loaded Chatterbox Multilingual V3 from its pinned official source revision with PyTorch 2.7.1 and CUDA 12.8.
- A warm direct render completed in 3.71 seconds and produced 7.44 seconds of audio.
- The integrated processor-to-cloned-voice-to-Opus replay completed in 2.20 seconds.
- The approved Opus artifact SHA-256 is `4c0b5a089435f9e07d10c999caccc94730b94e08b407917d1b2b0092850279e6`.
- Revocation was exercised independently and blocked rendering; a consented ready profile is installed for the authorized preacher.
- The preacher's authorization to use the sample was renewed. The first Russian-reference English clone is not yet accepted for identity/naturalness: the project owner reported excessive Russian accent and weak resemblance. Chatterbox's documented cross-language mitigation is now enabled (`cfg_weight=0`), and a clean English reference remains the required next subjective comparison.
- The processor uses a key from the non-sharing `Multilinguum Production Private` API project. The sharing-enabled development project is retained only for synthetic benchmarks and complimentary eligible text requests.

This closes the hardware installation and basic cloned-voice feasibility gate. It does not close the two-hour latency/load gate or venue acceptance.

## Still to implement

- Compatibility results for every RU/EN to EN/RU/ES/UK combination.
- Automatic Piper Ukrainian fallback.
- mDNS discovery, one-time pairing completion, client certificate issuance, and stored server fingerprint verification. The current pairing offer is explicitly marked bootstrap-only.
- Listener counts fed back from LiveKit into `ChannelHealth`.
- Provider reconnect/resume logic for active Realtime sessions; the current path isolates a failed direct channel and routes subsequent finalized source clauses through the cascade, but does not resume the failed socket.
- Translation-audio silence trimming/pacing and listener-side capture-to-playout measurement. Raw provider `elapsed_ms` alignment is not an acceptance latency.
- Local faster-whisper and TranslateGemma provider implementations.
- Signed macOS packages and update distribution.

## Release gates

Do not describe the system as service-ready until all checks in [Acceptance](ACCEPTANCE.md) pass on the actual church mixer, MacBook Air, Linux/NVIDIA server, LiveKit plan, public hostname, and representative phones.
