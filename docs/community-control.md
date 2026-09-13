# Heritage and SyncShow live control

The processor supplies two versioned browser modules: `client/heritage.js` for listeners and `client/operator.js` for the church manager console. The latter exports `clientVersion = 1` and `mount(element, { initialLease, requestAccess })`, returning a disposer. `initialLease` contains `token`, `expiresAtUnixMs`, and the public `apiBase`; `requestAccess()` renews those fields through the host's authenticated server. The module uses a shadow root, keeps leases in memory, and opens no audio input until the operator chooses **Connect this mixer**.

Heritage exposes the console at `/admin/live-translation`. A church manager or system administrator can request a lease. A paired SyncShow connection must explicitly include `syncshow:translation:control`; existing song/sermon permissions do not grant translation access. Heritage rechecks membership and connection validity on every renewal.

## Processor contract

- `POST /api/control/leases` accepts `{ subject }` with the permanent processor bearer key. This route is server-to-server only and is not included in Heritage's proxy.
- A signed lease lasts ten minutes and grants preflight, create/current/start/stop, channel controls, operator events, mixer capture, and listing/uploading the church's translation reference notes. It cannot mint leases, replay transcripts, or read/change archives or voice profiles. Note uploads stay on this server; selecting them for an Economy service additionally requires that service's explicit sharing choice.
- HTTP calls use `Authorization: Bearer <lease>`. WebSockets use the `multilinguum-auth.<lease>` subprotocol, never a URL query token.
- Both WebSockets accept `{ type: "renew-auth", token }`. Renewal must have the same operator subject and scope, and arrive before expiry. Invalid renewal closes the socket and immediately rejects further input. Membership revocation therefore takes effect at the next renewal, with a maximum ten-minute lease window.
- The capture socket sends `{ type: "capture-ready", sessionId }` after the provider pipeline starts. Clients must wait for this before sending binary PCM. Only one capture console is admitted; another console may still change translation settings or stop the service.
- The operator renews every two minutes without restarting capture. A lost or congested capture stream requires an explicit reconnect. It does not silently claim the mixer again.
- Concurrent create/start/stop requests are serialized. Two controllers cannot create competing sessions after the same empty-state read.

The managed console initially offers English/Russian cloud text, optional generated speech, and side-by-side current captions. Source audio comes from YouTube on `/live`. Advanced archive/voice-profile controls remain in the standalone operator. Quality/Economy profile selection, broadcast alignment, and SyncShow projection layouts are separate pending integration work.

## Current verification boundary

The control authorization and socket-lease logic are covered by local tests. Production client builds are included in the processor Docker build. A real mixer, cloud provider calls, translated audio relay, Docker image execution, and a church-service rehearsal still require acceptance. No shared-data opt-in or provider account configuration is performed by this console.

# Companion maintenance

The Heritage deployment companion uses the master-only `POST /api/maintenance`
with `{ "enabled": true }` before backup, update, or restore. Prepared and live
sessions refuse maintenance; finish the service first. Once accepted, new session
mutations are refused until maintenance is disabled or the processor restarts.
The Community public proxy does not expose this endpoint.

The host stops the idle processor before copying its SQLite archive and starts it
again afterward. SIGTERM closes the HTTP server and archive database. Companion
protocol version `1` is declared in `services/processor/heritage-companion.version`;
the installer requires that contract as well as a clean, exact source revision.
