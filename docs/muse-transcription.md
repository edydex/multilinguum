# Muse recognition

In the standalone console, open **Processing node → Muse recognition settings**. In an updated Heritage Community, use **Live translation → Muse recognition settings** with a church manager account. Paste the API token and choose **Save and test token**. The check authenticates without uploading speech. Session-control leases and paired SyncShow devices cannot read or change provider credentials.

Choose **Automatic**, **Muse**, or **OpenAI** under Speech recognition before starting a session. Automatic prefers Muse for English when configured; it uses OpenAI for Russian and when Muse is not configured. The session records the actual recognition model, and observed usage uses that model's rate. There is no silent provider change during an active session. A failed connection is reported to the operator.

Selected sermon notes contribute a bounded vocabulary list to both recognizers. Extraction runs locally: names and repeated terms become hints, not instructions to recite the outline. The text translator still receives relevant note excerpts through the existing retrieval workflow. Economy still requires its existing explicit notes-sharing choice. Speech generation remains optional and separate from recognition. No new data-sharing opt-in is enabled.

## Storage and server configuration

The token is encrypted with AES-256-GCM in `ARCHIVE_ROOT/private-provider-settings/muse.json`, with a key derived from `PROCESSOR_CONTROL_TOKEN`. The directory is mode 0700 and the file 0600. The token is never returned in API responses or saved in browser storage. Remote standalone configuration requires HTTPS; local connections may use loopback HTTP. Browser input is cleared after successful saving.

Back up the encrypted settings with the matching processor master credential. After rotating that credential, paste the Muse token again. An unreadable stored credential disables Muse configuration until it is replaced; other processor features remain available. Removing a saved token restores `MUSE_API_KEY` from the server environment if one exists. Finish the current session before changing credentials.

Environment-only setup remains available with `MUSE_API_KEY` and `TRANSCRIPTION_PROVIDER=auto|muse|openai` (default `auto`). Never put provider keys in a `VITE_` variable, service document, or repository.

## Provider limits and verification

The adapter uses `muse-voice-transcribe-1.0`, the authenticated WebSocket handshake, paced binary PCM, cumulative partials, and final speech-turn events. It drains before rotating at 55 minutes. Russian is absent from the provider's supported language list; Muse supplies turn timestamps, not word timestamps. The published recognition rate checked on 2026-09-20 is $0.18/hour. [Meta speech documentation](https://dev.meta.ai/docs/speech-to-text).

Local tests cover overlapping and out-of-order turns, duplicate completions, PCM transport, language selection, rotation, bounded shutdown, secret redaction and encrypted storage. A real 12.306-second English fixture passed recognition, including Ezekiel, Nebuchadnezzar and justification. That fixture used macOS speech synthesis; it is not evidence of human sermon quality, venue latency, microphone acceptance, or Russian recognition. Browser configuration checks used fake credentials and mocked APIs in Chromium and Firefox.

Deployment and release verification are recorded separately in the private Heritage integration repository. Source tests alone do not prove that WOTBC is running this version.
