# Security and privacy

## Trust boundaries

- Public listener: untrusted, anonymous, subscribe-only.
- Operator console: private controller with a paired credential; no provider secrets.
- Processor: authoritative service state and provider-secret boundary.
- Voice worker: private container network, separate bearer token, encrypted profiles.
- Archive volume: encrypted host storage, UID-restricted container mount.

## Secret rules

Never place OpenAI, LiveKit, Cloudflare, voice encryption, or archive credentials in:

- a React environment variable that is bundled by Vite;
- browser storage;
- capture frames, recordings, transcripts, manifests, logs, or exception messages;
- Git, Compose source, screenshots, or support bundles.

Production rejects the placeholder control and worker tokens. Use independent random values for each secret.

## Listener tokens

Tokens expire after five minutes and contain:

- one active room;
- `roomJoin: true`;
- `canSubscribe: true`;
- `canPublish: false`;
- `canPublishData: false`.

The listener page has no operator routes. The Cloudflare edge refuses every unknown `/api/` path.

## Voice consent

A profile cannot be used without a stored speaker, confirmation date, authorizer, permitted use, permitted languages, evidence reference, and active status. The first policy allows only RU to EN. Revocation updates the processor record and deletes the worker sample immediately.

The current profile creation API stores metadata first. Operational tooling must install the sample on the worker only after the metadata is reviewed, then mark the profile ready.

## Capture transport

Loopback development may use `ws://127.0.0.1`. Production remote capture requires WSS at the reverse proxy. Each frame includes a timestamp and sample count; stale clocks, malformed lengths, duplicate capture consoles, wrong sessions, and unauthorized tokens are rejected.

The mTLS pairing milestone is not complete. Until it is, do not expose the capture endpoint directly to a hostile network.

## Reporting

Do not open a public issue containing a real API key, archive, transcript, voice sample, pairing credential, church network detail, or listener token. Revoke the affected secret first and share only a minimal sanitized reproduction.
