# Authorized sermon RU to EN rehearsal — 2026-08-29

This rehearsal used the authorized 45-second Russian sermon excerpt identified in
`fixtures/authorized-sermon.json`. The recording was processed with the API key from the private,
non-sharing production project. The recording, transcripts, and voice artifacts remain in ignored
private fixture directories and are not committed.

## Integrated live cascade

The production capture route streamed the 48 kHz source in wall-clock time through
`gpt-live-transcribe`, glossary-aware `gpt-5.6-terra`, and the consented RU to EN voice profile.
Because `gpt-live-transcribe` rejected generic server VAD, the compatibility run explicitly
committed four-second transcription windows.

- First finalized Russian caption: 4.622 seconds after capture began.
- First finalized English caption: 8.043 seconds after capture began.
- Transcription first-delta p50: 823 ms; p95: 2.955 seconds.
- Final transcription p50: 4.699 seconds; p95: 5.020 seconds from each window start.
- Terra translation p50: 1.961 seconds; p95: 3.423 seconds.
- Speech render p50: 2.178 seconds; p95: 3.444 seconds.
- Twelve source and English transcript windows completed with no provider failure.
- Nine English windows used Chatterbox. The last three correctly fell back to natural voice after
  backlog crossed the ten-second safety threshold.

This run is a transport, timing, archive, and fallback success, but an accuracy-gate failure. Fixed
four-second commits split words and clauses, which damaged both the source transcript and the
translation. The live cascade therefore needs clause-aware commit boundaries before it can be the
default sermon path. The timing values are processor measurements before LiveKit and browser
playout, not listener end-to-end latency.

## Coherent quality reference

The same source was then processed as one coherent excerpt to establish the useful voice and
translation reference independently of the live segmentation defect:

- `gpt-transcribe` completed in 3.638 seconds.
- `gpt-5.6-terra` completed in 2.186 seconds using 266 input and 112 output tokens.
- Chatterbox rendered five complete sentence clauses in 19.224 seconds.
- Total processing after the file was ready: 25.048 seconds.
- Final normalized English duration: 40.080 seconds.
- Final loudness: -16.2 LUFS integrated; -2.2 dBFS true peak.

An independent `gpt-4o-transcribe` pass agreed with the source transcript wording. A separate
`gpt-transcribe` pass over the final English audio recovered all translated sentences, including
the final sentence that a rejected single long voice render had omitted. Sentence-sized voice
rendering is therefore required until the cloned model proves it can complete longer requests.

## Retained private evidence

The final ignored evidence directory is
`fixtures/private/multilinguum-authorized-quality-final-20260829/`.

- Source WAV SHA-256: `f8bfae7555bbecebb92a43decdb44289867a56a6e43e7443586ea7ac9c6bb0f0`
- English cloned WAV SHA-256: `fdd5bd0d2003634399af5f7022b1dc6676daee0906ca761d6d1605aa3c32e39a`
- English cloned Opus SHA-256: `48329e6e681804e9b0fabcb3cc5767906afcdec638a1d8ea1ee4ee911c1e228e`
- Private report SHA-256: `0c913c6cc96a850c97b3ca30493f679fa293110d0f547802435dcdf98fcce60d`

The coherent reference is appropriate for preacher listening review. It is not evidence that the
live path meets the ten-second p95 listener latency target.
