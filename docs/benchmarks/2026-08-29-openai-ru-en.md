# OpenAI RU to EN feasibility benchmark — 2026-08-29

This benchmark used a self-authored synthetic Russian sermon-style passage. It did not send the authorized preacher's recording or voice profile to OpenAI. The source was generated once with `gpt-4o-mini-tts`, streamed in wall-clock time, and processed concurrently by `gpt-live-transcribe` and `gpt-realtime-translate`.

## Paid realtime result

- Source duration: 51.400 seconds.
- First source-caption delta: 751 ms after streaming began.
- Final source transcript: 51.904 seconds after streaming began, or 503 ms after the source ended.
- First translation-session source-text delta: 1,205 ms.
- First English transcript delta: 1,308 ms, 103 ms after the paired source-text delta.
- First translated-audio packet: 541 ms.
- First audible translated speech: approximately 2.102 seconds after streaming began, consisting of the first packet delay plus 1.561 seconds of initial silence in the returned audio.
- Translation tail drain: 4.401 seconds after the source stream ended.

The provider's per-event `elapsed_ms` value is alignment metadata. The harness retains it for analysis, but the calculated 17.349-second audio p50 and 25.151-second audio p95 arrival-lag values include generated silence and padding and are **not** listener-latency measurements. Listener latency must be measured after silence trimming, paced playback, relay delivery, and browser playout are integrated.

Source transcription was accurate enough for this synthetic passage, with no material meaning change. Direct realtime translation was fast but not yet acceptable as the sole doctrinally sensitive path:

- The aligned run correctly rendered `Благодать вам` as “Grace to you.”
- It strengthened `Если мы ошиблись` (“If we made a mistake” / “If we were wrong”) to “if we have sinned.”
- A separate successful run rendered `Благодать вам` as “Thanks to you,” showing output variability.

This is a compatibility success and an accuracy-gate failure. The product should retain direct realtime translation as a low-latency option, but route doctrinally sensitive channels through the glossary-aware text fallback until the evaluation set proves otherwise.

## Glossary-aware Terra fallback

The same problematic phrases were sent as synthetic text to `gpt-5.6-terra` with explicit glossary mappings. The request completed in 1.943 seconds and used 117 input tokens plus 42 output tokens. It produced:

> Grace to you and peace. If we made a mistake, let us be ready to acknowledge it, correct our course, and seek peace again. The Lord strengthens those who trust in Him.

The signed-in Usage dashboard classified all 159 tokens as `Data sharing incentive tier` and charged $0 for Terra input and output. This verifies that the complimentary allowance is useful for the text-translation stage of the fallback cascade. It does not cover Realtime Translate, Live Transcribe, or TTS.

## Account cost evidence

After the development attempts and two successful approximately 51-second paid runs, the project dashboard showed $0.16 total spend:

- `gpt-4o-mini-tts`: $0.051
- `gpt-live-transcribe`: $0.045
- `gpt-realtime-translate`: $0.061
- `gpt-5.6-terra`: $0

The $0.16 is the aggregate development-session spend, not a per-service estimate.

## Retained local evidence

The ignored evidence directory is `fixtures/private/multilinguum-cloud-benchmark-paid-aligned-20260829/`. Its files have these hashes:

- `source-ru.wav`: `c04683d9e9bfd11b1bd2a52f81f44de6bc9f826a373c4fcfacdba60b6dcd6e6f`
- `translated-en.wav`: `449aa69cd67eafc8460818ddb71e47a72ac585e0d00c7d10297e12fe103cf163`
- `report.json`: `4e53b22ac0bdcfce4026a87580f599c8c77ce5758fe67e2b5d85472cbc0ebb36`

Routine development should replay retained provider-event fixtures and audio rather than repeat paid calls. A short paid live rehearsal remains necessary after the production adapters, silence handling, relay, and browser playout are integrated; final venue and load acceptance remain separate gates.
