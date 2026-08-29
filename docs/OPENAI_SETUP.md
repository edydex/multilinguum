# OpenAI API setup

Multilinguum production calls require an OpenAI API project. ChatGPT or Codex usage credits do not transfer to API billing. A balance shown in the API Platform billing overview can be used.

## Recommended account setup

1. Sign in to the [API Platform billing overview](https://platform.openai.com/settings/organization/billing/overview).
2. If the existing USD 20 balance is shown there, do not buy more credit. If it is shown only in ChatGPT or Codex, add API billing separately and keep automatic recharge disabled for the spike.
3. Create a dedicated project named `Multilinguum`; do not reuse an unrelated development project's key.
4. Set the project budget alert to USD 20.
5. Create a project service account named `multilinguum-processor` and copy its project-scoped API key once.
6. Do not paste the key into chat, a repository file, a command argument, or a screenshot.

Official OpenAI documentation describes [API-key authentication](https://developers.openai.com/api/reference/overview#authentication), [project service accounts and keys](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/projects), and [project usage/cost reporting](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage).

## Install the key on the GPU processor

From a terminal in this repository, run:

```sh
scripts/configure-remote-openai.sh
```

Paste the key at the hidden prompt. The script sends it over SSH standard input, atomically updates `/opt/multilinguum/.env` with mode `0600`, restarts only the processor container, and verifies the configured provider. It never prints the key.

## Initial spend envelope

The first cloud check should be the authorized 45-second fixture, followed by a ten-minute live rehearsal only if every language is correct. At the published duration prices, three Realtime translation channels plus source transcription cost about USD 0.09 for 45 seconds and USD 1.19 for ten minutes. The planned two-hour service baseline is USD 14.28 before relay or fallback costs.

The direct [GPT-Realtime-Translate](https://developers.openai.com/api/docs/models/gpt-realtime-translate) and [GPT-Live-Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe) models do not support the API free tier, so a funded API project is required for the compatibility test.

## Data-sharing incentive

When the organization explicitly enables input/output sharing for the Multilinguum project and the dashboard says it is enrolled, eligible text-model traffic receives complimentary daily tokens automatically. The [official program terms](https://help.openai.com/en/articles/10306912-sharing-feedback-evals-and-api-data-with-openai) currently include `gpt-5.6-terra` in the 10M-token group (2.5M/day for usage tiers 1–2), but do not list Realtime Translate, Live Transcribe, or TTS. This can make the fallback cascade's text-translation stage complimentary; audio stages remain separately billed.

Only synthetic, public, or separately authorized data should use a sharing-enabled project. Open-source application code does not make sermon recordings or voice profiles public or authorize their use for model improvement.

Run the isolated eligibility and glossary check on the processor host with:

```sh
docker compose exec -T processor node dist/complimentary-benchmark.js
```

Confirm the request in the Usage dashboard: incentive tokens appear in usage under the data-sharing incentive service tier but do not appear as cost.
