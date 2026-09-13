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

Economy sends spoken text, recent translated context, following spoken-text preview when available, and the built-in terminology glossary. Sessions with private sermon-note attachments are rejected before any service is created. Personal Heritage notes and account records are not part of this input. Responses use `store: false`; this does not override a project's sharing settings.

Recognition and generated voice use the separate audio key and may incur charges even if text usage receives an allowance. The operator shows the actual models and published rates in an expandable details panel. For profile sessions, `estimatedCostUsd` is only the known recognition estimate and `costEstimateKind` is `transcription-only`; text tokens and optional voice are additional. Unknown custom-model rates are shown as unknown.

## Model evidence and acceptance

Official model pages checked on 2026-09-13:

- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra): Quality candidate; supported reasoning begins at `low`; ordinary text list price $10 input / $50 output per million tokens.
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra): lower-cost candidate; supports `none`; ordinary text list price $2 input / $12 output per million tokens.
- [GPT-Live-Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe): configured recognition model; $0.017 per minute.

These pages establish model capabilities and list prices, not account access, sharing eligibility, sermon translation quality, or real service latency. Both profile descriptors deliberately report `qualityValidated: false` and `allowanceVerified: false` until the acceptance workflow provides that evidence. The defaults are candidates, not a completed bilingual evaluation.

Before a real service, compare English → Russian and Russian → English on representative spoken material, checking Scripture names, negation, omissions, meaning, delay and speech cancellation. API contract tests use synthetic responses and never establish translation quality.
