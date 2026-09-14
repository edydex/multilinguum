# Service operations

## Text and optional audio

Each channel has an audio checkbox, editable before and during a service. Turn off **Generate translated speech** to keep translating captions without running speech generation. Turn off **Send original audio** as well for an entirely text-only service. Listener volume and Listen/Pause affect only that listener; they do not start or stop generation.

Captions publish as soon as translation is ready. When speech is enabled, a later update supplies narration timing for listeners who are playing audio. Turning audio off cancels pending render requests and clears queued relay frames. A channel using direct speech translation closes that provider connection and continues through shared transcription plus text translation; re-enabling speech uses the cascade for the rest of that capture session.

Text-only sessions do not connect to LiveKit. Natural cloud speech needs OpenAI and an audio relay, but no GPU worker. The optional cloned-voice worker requires the `cloned-voice` Compose profile and `VOICE_WORKER_URL=http://voice-worker:4320`. For normal cloud/text operation, leave `VOICE_WORKER_URL` empty and use `docker compose up -d processor`. Existing cloned-voice deployments must opt into the profile when updating.

The displayed service cost remains a planning baseline, not metered usage or a promise of free translation. Transcription and speech can incur charges even when a project has a shared-data text allowance.

## Before the first deployment

1. Put the Linux archive path on an encrypted volume.
2. Replace the processor control token. For cloned voice, also replace the worker token and create the 32-byte URL-safe base64 voice key.
3. Configure the OpenAI API project and usage alerts.
4. If audio is wanted, configure the LiveKit project and recheck its plan limits.
5. Put the processor behind TLS; do not forward private paths through the public Worker.
6. If cloned voice is wanted, install the consented preacher profile, verify its SHA-256, and keep natural voice as fallback.
7. Run the twenty-excerpt review and two-hour load test.

## Sunday preflight

1. Connect the MacBook Air to the mixer interface and disable sleep.
2. Select the clean pulpit feed, not the room microphone or main music mix.
3. Confirm healthy signal without clipping.
4. Confirm source language and each listener channel.
5. Confirm processor, disk, and internet status; check LiveKit for audio and the GPU worker for cloned voice.
6. Read the cost estimate and budget warning.
7. Open the public page on a phone and keep the audio unlock button visible.
8. Press Start only when the preacher begins. Pause or stop translation for music.

## During service

- Source language and voice selection remain locked. Audio generation can be switched on or off per channel.
- A failed channel may be muted or restarted without interrupting others.
- If clone backlog crosses ten seconds, use the automatic or manual natural fallback.
- Watch listener count, caption freshness, latency, backlog, and error text.
- If capture disconnects, restore the mixer device before restarting the channel.
- Internet loss prevents cloud translation and public relay; the local archive must still be safely finalized when possible.

## After service

1. Press Stop and wait for archive finalization.
2. Confirm every expected Opus and JSONL track has a hash.
3. Spot-check source/caption alignment.
4. Export anything needed before the 30-day deadline.
5. Use Retain only for an explicit operational reason.

## Deterministic rehearsal

With the processor running and no cloud credentials:

```sh
node scripts/replay-fixture.mjs
```

This validates the controller, four channels, archive index, JSONL output, integrity manifest, and Stop lifecycle. It does not validate speech quality, audio playback, LiveKit, or venue hardware.
