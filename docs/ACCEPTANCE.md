# Acceptance gates

## Translation quality

- Review at least twenty Russian sermon excerpts containing Scripture, names, numbers, pauses, emphasis, and restarts.
- Use bilingual review for all four target combinations.
- Allow zero meaning-reversing or doctrinally critical errors.
- Record lesser terminology errors and resolve them through the glossary.
- Confirm no inserted or hallucinated speech.

## Voice quality

- Preacher explicitly approves the RU to EN cloned output.
- Identity and naturalness each average at least 4/5.
- Natural fallback starts at a clause boundary when clone backlog exceeds ten seconds.
- Revocation disables clone immediately on both processor and worker.

## Reliability and latency

- p95 capture-to-listener audio is at most ten seconds.
- Report p50/p95 chunk, transcription, translation, voice-render, relay-submit, and listener-playout delay separately; do not hide the five-second chunk window inside provider latency.
- Backlog does not grow during a two-hour service.
- Fifty listeners remain connected across all channels for two hours.
- Test late join, phone sleep/wake, Wi-Fi change, Safari/Chrome audio unlock, and browser reconnect.

## Fault injection

- One translation provider fails.
- GPU worker fails or times out.
- Capture disconnects and the input device is removed.
- LiveKit disconnects and reconnects.
- Disk becomes low.
- Internet is lost.
- Processor restarts during an interrupted recording.

Other channels and completed archive data must remain intact.

## Security

- Anonymous token cannot publish audio or data.
- Public user cannot reach private APIs.
- No provider secret appears in either browser bundle, logs, manifests, recordings, or transcripts.
- Expired session token cannot rejoin.
- Remote capture rejects plaintext transport.

## Archive

- Every expected source/translation track and JSONL transcript exists.
- Playback and captions are aligned.
- Export, retain, delete, and automatic 30-day expiry work.
- Integrity hashes verify after a clean stop and recovery stop.

## Venue

Final approval requires the actual church mixer, the M3/16 GB MacBook Air, the Linux/NVIDIA server, representative iPhone and Android headphones, the production public URL, and a normal-length service.
