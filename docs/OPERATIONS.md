# Service operations

## Before the first deployment

1. Put the Linux archive path on an encrypted volume.
2. Replace all placeholder tokens and create the 32-byte URL-safe base64 voice key.
3. Configure the OpenAI API project and usage alerts.
4. Configure the LiveKit project and recheck the plan limits.
5. Put the processor behind TLS; do not forward private paths through the public Worker.
6. Install the consented preacher profile, verify its SHA-256, and keep natural voice as fallback.
7. Run the twenty-excerpt review and two-hour load test.

## Sunday preflight

1. Connect the MacBook Air to the mixer interface and disable sleep.
2. Select the clean pulpit feed, not the room microphone or main music mix.
3. Confirm healthy signal without clipping.
4. Confirm source language and each listener channel.
5. Confirm processor, GPU worker, LiveKit, disk, and internet status.
6. Read the cost estimate and budget warning.
7. Open the public page on a phone and keep the audio unlock button visible.
8. Press Start only when the preacher begins. Pause or stop translation for music.

## During service

- Configuration remains locked.
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
