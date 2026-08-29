# Voice modes and cloned-reference guidance

Multilinguum presents three product-facing output choices. Provider names stay behind the shared
provider boundary and are not exposed as normal operator decisions.

| Console choice       | Pipeline                                                                | Behavior                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generic · Fast       | GPT-Realtime-Translate                                                  | Starts speaking while translated audio is arriving. Lowest delay, but cadence and meaning-sensitive clause context are less reliable.                                    |
| Generic · Expressive | GPT-Live-Transcribe → glossary-aware text translation → GPT-4o Mini TTS | Waits for a finalized clause, renders upcoming clauses ahead, trims synthetic edge silence, and queues gapless natural narration. This is the accuracy-oriented default. |
| _First name_ Voice   | Finalized translated clause → Chatterbox Multilingual V3                | Uses a consented reference for voice identity. If cloned rendering accumulates more than ten seconds of backlog, the live channel falls back to Generic · Expressive.    |

The console also offers **Add cloned voice…** for the v1 RU→EN channel. It records the speaker,
authorizer, confirmation date, permitted use, permitted language, reference language, sample hash,
and encrypted worker location. The raw sample is sent only to the processor and encrypted by the
voice worker; it is never stored in the desktop renderer or repository.

Expressive speech uses 0.98× as its calm default cadence. It does not compress each translated
sentence to fit the source window. Gentle catch-up begins only when actual LiveKit playback plus
in-flight rendering exceeds 20 seconds: 1.03×, then 1.07× above 30 seconds, with a hard 1.12×
ceiling. The operator's Queue metric is this real playback estimate.

## What the first clone used

The first authorized test was zero-shot conditioning, not model training or fine-tuning. The worker
passed the complete 45-second Russian fixture to Chatterbox Multilingual V3 for every render with
`exaggeration=0.5` and, originally, `cfg_weight=0.35`.

Chatterbox's current implementation uses the reference in three different ways:

- the voice encoder sees the complete reference to calculate the speaker embedding;
- the speech-conditioning prompt uses only the first six seconds;
- the decoder reference uses only the first ten seconds.

This means the problem was not too little recording. The more important mismatch was asking for
English output from a Russian reference. Chatterbox explicitly warns that mismatched reference and
output languages can transfer the reference language's accent. Multilinguum now sends
`cfg_weight=0` for cross-language and legacy profiles, which is Chatterbox's documented mitigation.

For the best English clone, record a clean English reference around ten seconds long. Natural
sermon delivery is preferable to reading a synthetic consent sentence: use the normal microphone,
one speaker, no music or congregation, low room echo, and no clipped peaks. A full English sermon
is unnecessary. Add a second short take only if the first does not contain the preacher's normal
warmth and cadence.

Primary references:

- https://github.com/resemble-ai/chatterbox#original-chatterbox-tips
- https://github.com/resemble-ai/chatterbox/blob/master/src/chatterbox/mtl_tts.py
- https://developers.openai.com/api/docs/models/gpt-realtime-translate
- https://developers.openai.com/api/docs/models/gpt-live-transcribe
- https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
