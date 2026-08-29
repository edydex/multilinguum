import type {
  RenderedSpeech,
  SpeechRenderer,
  TranscriptSegment,
  VoiceProfile,
} from '@multilinguum/protocol';

export class VoiceWorkerSpeechRenderer implements SpeechRenderer {
  readonly name = 'chatterbox-multilingual-v3';
  readonly #baseUrl: URL;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = new URL(baseUrl);
    this.#token = token;
  }

  async render(segment: TranscriptSegment, profile?: VoiceProfile): Promise<RenderedSpeech> {
    if (!profile || profile.status !== 'ready' || profile.consent.revokedAt) {
      throw new Error('A ready, non-revoked voice profile is required for cloned output.');
    }
    const response = await fetch(new URL('/v1/render', this.#baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: segment.text,
        language: segment.language,
        profileId: profile.id,
        sourceStartMs: segment.sourceStartMs,
        sourceEndMs: segment.sourceEndMs,
        sequence: segment.sequence,
      }),
      signal: AbortSignal.timeout(9_000),
    });
    if (!response.ok) {
      throw new Error(`Voice worker failed with ${response.status}.`);
    }
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      encoding: 'pcm_s16le',
      sampleRate: 48000,
      startMs: segment.sourceStartMs,
      endMs: segment.sourceEndMs,
      sequence: segment.sequence,
      language: segment.language,
      renderer: this.name,
    };
  }

  async health(): Promise<{ ready: boolean; detail?: string }> {
    try {
      const response = await fetch(new URL('/health', this.#baseUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      return { ready: response.ok, detail: await response.text() };
    } catch (error) {
      return { ready: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
