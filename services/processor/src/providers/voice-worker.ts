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
        // Chatterbox recommends CFG 0 for cross-language transfer because otherwise
        // the output can inherit the reference language's accent. Profiles created
        // before referenceLanguage was recorded are the current RU -> EN profile.
        cfgWeight: profile.referenceLanguage === segment.language ? 0.35 : 0,
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

  async installProfile(profile: VoiceProfile, sample: Uint8Array): Promise<void> {
    if (profile.status !== 'pending' || profile.consent.revokedAt) {
      throw new Error('Only a pending profile with active consent can receive a sample.');
    }
    const form = new FormData();
    const copiedSample = Uint8Array.from(sample);
    form.append('sample', new Blob([copiedSample.buffer], { type: 'audio/wav' }), 'reference.wav');
    const response = await fetch(new URL(`/v1/profiles/${profile.id}/sample`, this.#baseUrl), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'x-sample-sha256': profile.sampleSha256,
        'x-consent-active': 'true',
      },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`Voice worker rejected the reference sample with ${response.status}.`);
    }
  }

  async revokeProfile(profileId: string): Promise<void> {
    const response = await fetch(new URL(`/v1/profiles/${profileId}`, this.#baseUrl), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Voice worker failed to revoke the profile with ${response.status}.`);
    }
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
