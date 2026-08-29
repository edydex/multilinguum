# Latency measurement

Multilinguum records a timing sample for every finalized source segment and language channel. The operator shows latest end-to-end delay plus rolling p50/p95 stage measurements. Completed archives contain `latency.jsonl`, its SHA-256, and per-channel summaries in `manifest.json`.

## Stages

- `chunkWindowMs`: source audio covered by the segment. The current fallback cascade uses five-second chunks; this is shown separately rather than charged to the transcription API.
- `chunkReadyDelayMs`: capture timestamp to a complete chunk on the processor. This includes capture-to-node network delay and clock offset.
- `captureToTranscriptionStartMs`: source-end timestamp to the moment the transcription request begins. Growth here indicates processor queueing or backlog.
- `transcriptionFirstDeltaMs`: request start to first streaming transcript delta when the realtime adapter supplies one.
- `transcriptionMs`: request start to finalized source transcript.
- `translationFirstDeltaMs`: translation start to first translated delta when the provider supplies one.
- `translationMs`: finalized source transcript to finalized translated text. This is the isolated ChatGPT translation contribution in the fallback cascade.
- `speechRenderMs`: translated text to completed natural or cloned PCM.
- `captionPublishMs` and `audioPublishMs`: time spent handing output to the configured relay.
- `sourceEndToTranscriptMs`, `sourceEndToCaptionMs`, and `sourceEndToAudioMs`: end-to-end processor measurements from the latest captured source audio.
- `sourceStartToAudioMs`: worst position in the segment, including the chunk window.

The final venue test also needs a listener-side probe because relay submission is not the same as sound reaching a phone. Capture and processor clocks must be synchronized; a negative capture-derived value is retained as evidence of clock skew rather than silently clamped in the archive.

## Paid-call strategy

Routine development uses deterministic replay and retained timing/provider fixtures. Cloud calls are intentionally limited to:

1. the authorized 45-second compatibility matrix after timing instrumentation is deployed;
2. one short live rehearsal after the direct Realtime adapters and relay path are integrated;
3. the final end-to-end/load/venue acceptance runs.

A single initial cloud run cannot replace the short live rehearsal because recorded-file success does not exercise streaming deltas, reconnects, queue growth, or listener delivery.
