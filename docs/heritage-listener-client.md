# Shared Heritage live client, version 1

The listener build produces the standalone listener and `dist/client/heritage.js` with its JavaScript chunks. Heritage imports `clientVersion` and `mount(element, options)` from that public module. `mount` returns a cleanup function. Options contain only `apiBase`, `churchName`, an optional 11-character YouTube `videoId`, and an optional public `channelUrl`.

The processor Docker image includes the built client under `/app/client`; `/client/:file` serves only flat JavaScript filenames. Development runs can set `LISTENER_CLIENT_ROOT` to the listener's `dist/client` directory. The listener Worker distributes the same build. Missing modules return 404, not the SPA shell. Module and anonymous API responses allow cross-origin public reading; operator authentication and its origin restrictions remain separate.

A cohosted Heritage deployment routes these public paths:

- `/translation/client/:file` → processor `/client/:file`
- `/translation/api/public/service`, `/events`, `/token`, and `/audio/:sessionId/:clipId.wav` → corresponding processor public endpoints, including the events WebSocket

Heritage's build-time `TRANSLATION_PROCESSOR_URL` defaults to `http://translation-processor:4310`. Its public church setting is `/translate`. No processor control routes or provider credentials are exposed through these rewrites. An external listener base URL is also supported; a path prefix must be the base where `client/` and `api/public/` live.

Deploy the processor and listener client together. This client requires public-state heartbeats (10 seconds); after 30 seconds without events it closes the connection, stops translated playback, and reconnects. Reconnection, session replacement, and operator audio-off never automatically resume a listener's stopped audio. Private session/health configuration is no longer broadcast on the public socket.

## Listener behavior

Quality/Economy translated speech is delivered through a bounded window of rendered audio clips over the existing Community HTTP connection. It needs the OpenAI audio provider, but no LiveKit account or separate audio server. The same speech toggle is available in Community and SyncShow. These buffered-only services do not connect to LiveKit, even when relay credentials are stored; an unavailable optional relay cannot block their startup or audio. Services containing a direct Realtime channel retain the configured LiveKit path. A listener's Stop audio control affects only that listener. The operator's speech-off switch prevents new speech rendering and discards queued playback while captions continue.

Text language and audio are independent. The text preference is retained on the same browser; audio always requires a new listener choice after navigation. `/live` uses YouTube for original audio and excludes the separate delayed source track. `/translate` can offer the source track without a video. Selecting translation stops previous audio and waits for the YouTube API to confirm muting. Selecting original audio stops translated audio synchronously before unmuting YouTube. Pausing, ending, or detecting a seek stops translated playback.

YouTube's documented API has no volume-change event. Native unmuting is observed every 200 ms; this bounds detection, but is not proof that manually operating native YouTube controls can never create momentary overlap. The controlled audio choices are covered by ordering and cancellation tests. Actual YouTube/LiveKit playback still requires a browser service rehearsal.

“Float translation” opens a resizable panel on the page. Its “Pop out” control uses Document Picture-in-Picture when available; rejection retains the page panel. Audio remains owned by the parent player, so moving caption controls does not create another media connection. A browser which closes a native floating window returns the controls to the page.

## Remaining acceptance

The broadcast-delay church setting and listener timing adjustment schedule source-timed captions and buffered speech. Direct Realtime audio does not have the same source-clock alignment and remains a separate relay path. A real live/DVR rehearsal must still establish capture timestamps, translation playout, broadcast delay, seek handling, and phone playback before the combined audio experience is accepted.

The local Codex browser rendered and switched both synthetic language feeds through Heritage, and floated/returned the page panel. YouTube remained blank in both the integrated player and an independent plain-iframe comparison; its direct embed reported missing-referrer error 153. This is not successful video playback evidence. Native Document PiP and phone-size playback remain unverified in that browser.

The September 14 local relay rehearsal used LiveKit 1.13.7 with disposable credentials and synthetic tones. It verified native receiver audio, queue clearing, listener counts, reconnect, and browser WebRTC connection/stop, alongside buffered browser playback. It did not use a microphone, paid providers, LiveKit Cloud, or physical listening devices.

A separate September 14 outage rehearsal configured a local relay endpoint that rejected connections. Both Quality and Economy started and played synthetic audio in the browser without a relay request. Operator speech-off stopped listener audio while new captions continued without new rendering; re-enabling Quality speech required a fresh listener audio choice. Provider calls were blocked. This verifies delivery behavior, not translation quality or venue readiness.

## Continuous OpenAI interpretation

Planned SyncShow cues use `gpt-realtime-translate` for translated text and audio.
Capture travels through the church processor to OpenAI over one persistent
translation WebSocket; an independent OpenAI recognizer supplies original-language
captions. Translation does not wait for that recognizer, a GPT text request, or TTS.
Muse remains available for separately configured sessions and is not invoked by these cues.

Translated text deltas are identified as `delivery: streaming`; they can be displayed
immediately, while provisional recognition remains provisional. Sentences stay together
until punctuation or a bounded unpunctuated-text limit. There is no reading-speed display
queue for this stream. The realtime interpreter supplies its own voice; saved cascade
voice choices do not change it.

Realtime PCM audio is grouped into short chunks for the existing public listener relay.
This works without LiveKit. Chunks have `timingBasis: output` and are scheduled contiguously
by the browser audio player. They are not represented as source-video alignment, so the
video-synchronized listener excludes them; phone listeners should use `/translate`.
A realtime provider failure stops capture visibly rather than switching silently to the
slower cascade. Stop drains the provider, then finalizes the archive.
