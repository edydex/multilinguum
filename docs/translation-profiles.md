# Translation profiles

The Community and SyncShow operator controls offer **Quality** and **Economy · shared-data allowance** before a service starts. The processor selects and locks the actual text provider for the session. Its model and billing configuration are recorded in the private archive manifest. Public listeners receive captions and availability, without profile configuration or credentials.

Both profiles use live speech recognition → text translation → optional generated speech. Turning speech off cancels speech generation while captions continue. Neither profile needs the cloned-voice worker or a GPU. Translated audio still needs the configured audio relay.

## Configure the processor

Keep keys in the private server environment, never in the browser or a repository. The base `OPENAI_API_KEY` is used for recognition and speech. Quality can use that key or its own text-project key. Economy requires a separate text-project key and never falls back to the base or Quality key.

| Setting                            | Default / meaning                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `OPENAI_QUALITY_TEXT_API_KEY`      | Optional; otherwise uses `OPENAI_API_KEY`                                                               |
| `OPENAI_QUALITY_TEXT_MODEL`        | `gpt-6-astra`                                                                                           |
| `OPENAI_QUALITY_REASONING_EFFORT`  | `low`                                                                                                   |
| `OPENAI_ECONOMY_TEXT_API_KEY`      | Required for Economy; use a dedicated sharing project                                                   |
| `OPENAI_ECONOMY_TEXT_MODEL`        | `gpt-5.6-terra`                                                                                         |
| `OPENAI_ECONOMY_REASONING_EFFORT`  | `none`                                                                                                  |
| `OPENAI_ECONOMY_SHARING_CONFIRMED` | `false`; set `true` only after checking that project's sharing and model eligibility in OpenAI settings |
| `OPENAI_ECONOMY_OVERAGE_POLICY`    | `block`; `allow-billed` accepts possible charges when no allowance applies                              |

For the Heritage companion, use the corresponding `TRANSLATION_` prefix in place of `OPENAI_` for these eight profile settings. Supply them through the private environment when running `heritage-community translation configure --non-interactive --yes` with the pinned source and revision. The setup command saves supplied values privately and preserves existing values on later updates. Audio uses `TRANSLATION_OPENAI_API_KEY`.

Keep the audio and Quality keys in projects whose data settings match their intended use. Different key strings alone do not prove separate projects or privacy settings; that remains an administrator setup check.

## Sharing allowance and charges

Selecting Economy does not opt an account or project into sharing. This application cannot verify account eligibility, the current eligible-model list, remaining complimentary usage, or usage from other applications. Check [OpenAI project sharing settings](https://platform.openai.com/settings/organization/data-controls/sharing) directly.

Economy therefore defaults to **blocked**. The current implementation can run only when an administrator confirms the text-project setup and explicitly permits billed overage. It does not yet provide a guaranteed zero-charge mode or a provider-backed allowance stop. No automatic retry, project fallback, or profile change occurs if the selected text request fails. Text requests have a 30-second timeout, a 4,096-token output ceiling, and zero automatic SDK retries; these bounds are not a service spending limit.

Economy sends spoken text, recent translated context, following spoken-text preview when available, and the built-in terminology glossary. Selected sermon notes are optional. In the Community or SyncShow translation console, open **Sermon notes**, upload/select up to eight PDF/text documents, and turn on **Use sermon notes for translation**. For Economy, also choose **Share selected notes with Economy for this service**. That choice resets when the selected documents, profile or service changes and is fixed once the service is created. Direct API clients must set `shareSermonNotesWithEconomy: true` alongside their selected `contextDocumentIds`; older clients remain opted out.

The server keeps uploaded documents locally and sends retrieved excerpts only when their selected service translates speech. The sharing choice and selected document IDs are retained in the private archive metadata. Filenames and note content are not published to congregation endpoints. Personal Heritage notes and account records are not part of this input. Responses use `store: false`; this does not override a project's sharing settings. Relevant context can help terminology and Scripture matching, but actual improvement needs a bilingual evaluation; the prompt forbids adding unspoken material or following instructions inside the notes. More context consumes input tokens.

Recognition and generated voice use the separate audio key and may incur charges even if text usage receives an allowance. The operator shows the actual models and published rates in an expandable details panel. For profile sessions, `estimatedCostUsd` is only the known recognition estimate and `costEstimateKind` is `transcription-only`; text tokens and optional voice are additional. Unknown custom-model rates are shown as unknown.

## Model evidence and acceptance

Official model pages checked on 2026-09-13:

- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra): Quality candidate; supported reasoning begins at `low`; ordinary text list price $10 input / $50 output per million tokens.
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra): lower-cost candidate; supports `none`; ordinary text list price $2 input / $12 output per million tokens.
- [GPT-Live-Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe): configured recognition model; $0.017 per minute.

These pages establish model capabilities and list prices, not account access, sharing eligibility, sermon translation quality, or real service latency. Both profile descriptors deliberately report `qualityValidated: false` and `allowanceVerified: false` until the acceptance workflow provides that evidence. The defaults are candidates, not a completed bilingual evaluation.

Before a real service, compare English → Russian and Russian → English on representative spoken material, checking Scripture names, negation, omissions, meaning, delay and speech cancellation. API contract tests use synthetic responses and never establish translation quality.

### Committed-turn recognition candidate

`OPENAI_TRANSCRIBE_MODEL=gpt-transcribe` is supported for controlled rehearsals. It uses the same real-time audio capture and pause detection, with final text after a committed turn. The adapter omits the live-only `delay` field and allows up to 30 seconds of uninterrupted speech before a safety commit; detected pauses normally commit sooner. `gpt-live-transcribe` remains the configured default and retains its eight-second safety limit. This recognition choice is separate from the Quality/Economy text-model choice.

In the September 14 original-host rehearsal, the actual capture pipeline processed a 45-second authorized Russian sermon excerpt and a known 10.49-second English fixture. Natural-pause commits preserved words that the eight-second cut had lost, including the complete English negation “We do not earn it by good works.” Russian terminology errors remained. This is a small comparison, not a bilingual quality acceptance, deployment, microphone test, or full listening workflow; no translated speech was generated in this comparison. The operator currently shows an unknown recognition rate for this explicitly selected candidate.

Final recognition results are delivered to translation in audio order even when provider completions arrive out of order. Empty or failed turns release later completed text; a missing result produces an error after 30 seconds instead of holding later text indefinitely. Failed audio is not reconstructed. See the provider's [transcription event guidance](https://developers.openai.com/api/docs/guides/realtime-transcription) for the committed-turn workflow and completion-order contract.
