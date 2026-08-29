import OpenAI, { toFile } from 'openai';
import type { Language } from '@multilinguum/protocol';

function wavFromPcm48kMono(pcm: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(96_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(header, 0);
  wav.set(pcm, 44);
  return wav;
}

export class OpenAIChunkTranscriber {
  readonly name: string;
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(apiKey: string, model: string) {
    this.#client = new OpenAI({ apiKey });
    this.#model = model;
    this.name = `openai-file-transcription:${model}`;
  }

  async transcribe(pcm: Uint8Array, sourceLanguage: 'en' | 'ru'): Promise<string> {
    const file = await toFile(wavFromPcm48kMono(pcm), 'live-chunk.wav', {
      type: 'audio/wav',
    });
    const transcript = await this.#client.audio.transcriptions.create({
      file,
      model: this.#model,
      language: sourceLanguage,
      prompt:
        sourceLanguage === 'ru'
          ? 'Церковная проповедь. Библия, Евангелие, Господь, благодать, оправдание.'
          : 'Church sermon. Bible, Gospel, the Lord, grace, justification.',
      response_format: 'json',
    });
    return transcript.text.trim();
  }
}

export interface CapturedPcmChunk {
  data: Uint8Array;
  startMs: number;
  endMs: number;
  sequence: number;
  language: Language;
}
