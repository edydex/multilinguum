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
- `playoutQueueMs`: actual LiveKit audio already queued when this rendered clause was submitted.
- `sourceEndToTranscriptMs`, `sourceEndToCaptionMs`, and `sourceEndToAudioMs`: end-to-end processor measurements from the latest captured source audio.
- `sourceStartToAudioMs`: worst position in the segment, including the chunk window.
- `sourceEndToPlayoutMs` and `sourceStartToPlayoutMs`: queue-aware estimates for when the first
  sample of the clause reaches relay playout. These replace relay acceptance as the operator's
  best server-side end-to-end estimate.

The final venue test also needs a listener-side probe because relay submission is not the same as sound reaching a phone. Capture and processor clocks must be synchronized; a negative capture-derived value is retained as evidence of clock skew rather than silently clamped in the archive.

## Paid-call strategy

Routine development uses deterministic replay and retained timing/provider fixtures. Cloud calls are intentionally limited to:

1. the authorized 45-second compatibility matrix after timing instrumentation is deployed;
2. one short live rehearsal after the direct Realtime adapters and relay path are integrated;
3. the final end-to-end/load/venue acceptance runs.

A single initial cloud run cannot replace the short live rehearsal because recorded-file success does not exercise streaming deltas, reconnects, queue growth, or listener delivery.

For a paid compatibility benchmark on the processor host, run:

```sh
docker compose exec -T processor node dist/cloud-benchmark.js
```

The benchmark creates its own non-private Russian speech fixture with the configured natural TTS model, streams the 24 kHz PCM in wall-clock time to both GPT-Realtime-Translate and GPT-Live-Transcribe, and writes source audio, translated audio, and a JSON timing report under `/tmp/multilinguum-cloud-benchmark` in the processor container. The report separates the first live-transcription delta, the translation session's source-transcript delta, translated transcript delta, translated audio delta, and tail-drain time.

The translation protocol's per-event `elapsed_ms` is alignment metadata, not a unique event identifier or direct capture-to-listener latency. Silence padding can make arrival-minus-`elapsed_ms` audio percentiles look much worse than audible output. Do not use those percentiles as an acceptance result; measure trimmed, paced audio at the listener after relay integration.

The first measured paid result and its limitations are recorded in [the 2026-08-29 OpenAI RU to EN report](benchmarks/2026-08-29-openai-ru-en.md).

The live capture route now feeds 48 kHz frames to a shared live transcriber and the active direct translation channels without waiting for a five-second file chunk. Source archive/original-audio publication remains five-second chunked. Realtime transcript clauses are finalized on punctuation, 240 characters, three seconds of aligned source time, or session close; each finalized caption creates an archive latency sample. Expressive audio is rendered ahead, edge-trimmed, and queued in source order. Server-side latency now includes actual LiveKit queue depth, but remains provisional until a listener-side acoustic probe measures sound reaching a phone.
