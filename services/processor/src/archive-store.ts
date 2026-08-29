import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ArchiveManifest,
  ArchiveStore,
  PipelineLatencySample,
  RenderedSpeech,
  ServiceSession,
  TranscriptSegment,
} from '@multilinguum/protocol';
import { summarizeLatency } from './latency.js';

const execFileAsync = promisify(execFile);

function assertSafeId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
    throw new Error('Unsafe archive identifier.');
  }
}

async function sha256File(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
}

export class FileArchiveStore implements ArchiveStore {
  readonly #root: string;
  readonly #retentionDays: number;
  readonly #database: DatabaseSync;

  constructor(root: string, retentionDays: number) {
    this.#root = path.resolve(root);
    this.#retentionDays = retentionDays;
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path.join(this.#root, 'index.sqlite'));
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS archives (
        session_id TEXT PRIMARY KEY,
        manifest_path TEXT NOT NULL,
        retention_deadline TEXT NOT NULL,
        retained INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
  }

  async create(
    session: ServiceSession,
    engineVersions: Record<string, string>,
  ): Promise<ArchiveManifest> {
    assertSafeId(session.id);
    const sessionRoot = this.#sessionRoot(session.id);
    await mkdir(path.join(sessionRoot, 'audio'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(sessionRoot, 'transcripts'), { recursive: true, mode: 0o700 });

    const retentionDeadline = new Date(
      Date.parse(session.createdAt) +
        (session.archivePolicy.retentionDays || this.#retentionDays) * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const manifest: ArchiveManifest = {
      version: 1,
      sessionId: session.id,
      createdAt: session.createdAt,
      sourceLanguage: session.sourceLanguage,
      engineVersions,
      audioTracks: session.targets.map((channel) => ({
        channelId: channel.id,
        language: channel.targetLanguage,
        path: `audio/${channel.id}.opus`,
        codec: 'opus',
        sampleRate: 48000,
      })),
      transcripts: session.targets.map((channel) => ({
        channelId: channel.id,
        language: channel.targetLanguage,
        path: `transcripts/${channel.id}.jsonl`,
      })),
      latencyReport: {
        path: 'latency.jsonl',
        sampleCount: 0,
        channels: {},
      },
      retentionDeadline,
      retained: session.archivePolicy.retainIndefinitely,
    };
    await this.#writeManifest(manifest);
    this.#database
      .prepare(
        `INSERT INTO archives
          (session_id, manifest_path, retention_deadline, retained, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        this.#manifestPath(session.id),
        retentionDeadline,
        manifest.retained ? 1 : 0,
        session.createdAt,
      );
    return manifest;
  }

  async appendTranscript(segment: TranscriptSegment): Promise<void> {
    assertSafeId(segment.sessionId);
    assertSafeId(segment.channelId);
    const transcriptPath = path.join(
      this.#sessionRoot(segment.sessionId),
      'transcripts',
      `${segment.channelId}.jsonl`,
    );
    await appendFile(transcriptPath, `${JSON.stringify(segment)}\n`, { mode: 0o600 });
  }

  async appendAudio(sessionId: string, channelId: string, chunk: RenderedSpeech): Promise<void> {
    assertSafeId(sessionId);
    assertSafeId(channelId);
    if (chunk.encoding !== 'pcm_s16le' || chunk.sampleRate !== 48000) {
      throw new Error('Archive audio must be 48 kHz signed 16-bit PCM before Opus finalization.');
    }
    const manifest = await this.#readManifest(sessionId);
    const row = this.#database
      .prepare('SELECT completed_at FROM archives WHERE session_id = ?')
      .get(sessionId) as { completed_at: string | null } | undefined;
    if (!row || row.completed_at) {
      throw new Error(`Archive ${sessionId} is not active.`);
    }
    if (!manifest.audioTracks.some((track) => track.channelId === channelId)) {
      throw new Error(`Archive ${sessionId} does not own channel ${channelId}.`);
    }
    await appendFile(
      path.join(this.#sessionRoot(sessionId), 'audio', `${channelId}.pcm`),
      chunk.data,
      { mode: 0o600 },
    );
  }

  async appendLatency(sample: PipelineLatencySample): Promise<void> {
    assertSafeId(sample.sessionId);
    assertSafeId(sample.channelId);
    await appendFile(
      path.join(this.#sessionRoot(sample.sessionId), 'latency.jsonl'),
      `${JSON.stringify(sample)}\n`,
      { mode: 0o600 },
    );
  }

  async finalize(sessionId: string): Promise<ArchiveManifest> {
    const manifest = await this.#readManifest(sessionId);
    await Promise.all(
      manifest.audioTracks.map(async (track) => {
        const pcmPath = path.join(this.#sessionRoot(sessionId), 'audio', `${track.channelId}.pcm`);
        const opusPath = path.join(this.#sessionRoot(sessionId), track.path);
        let information: Awaited<ReturnType<typeof stat>>;
        try {
          information = await stat(pcmPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return;
        }
        if (information.size === 0) {
          await unlink(pcmPath);
          return;
        }
        await execFileAsync('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          's16le',
          '-ar',
          '48000',
          '-ac',
          '1',
          '-i',
          pcmPath,
          '-c:a',
          'libopus',
          '-b:a',
          '48k',
          opusPath,
        ]);
        await unlink(pcmPath);
      }),
    );
    const audioTracks = await Promise.all(
      manifest.audioTracks.map(async (track) => {
        const filePath = path.join(this.#sessionRoot(sessionId), track.path);
        try {
          await stat(filePath);
          return { ...track, sha256: await sha256File(filePath) };
        } catch {
          return track;
        }
      }),
    );
    const transcripts = await Promise.all(
      manifest.transcripts.map(async (transcript) => {
        const filePath = path.join(this.#sessionRoot(sessionId), transcript.path);
        try {
          await stat(filePath);
          return { ...transcript, sha256: await sha256File(filePath) };
        } catch {
          return transcript;
        }
      }),
    );
    let latencySamples: PipelineLatencySample[] = [];
    let latencySha256: string | undefined;
    const latencyPath = path.join(this.#sessionRoot(sessionId), manifest.latencyReport.path);
    try {
      const contents = await readFile(latencyPath, 'utf8');
      latencySamples = contents
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PipelineLatencySample);
      latencySha256 = await sha256File(latencyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const groupedLatency = new Map<string, PipelineLatencySample[]>();
    for (const sample of latencySamples) {
      const channelSamples = groupedLatency.get(sample.channelId) ?? [];
      channelSamples.push(sample);
      groupedLatency.set(sample.channelId, channelSamples);
    }
    const latencyReport: ArchiveManifest['latencyReport'] = {
      path: 'latency.jsonl',
      sampleCount: latencySamples.length,
      channels: Object.fromEntries(
        [...groupedLatency].map(([channelId, samples]) => [channelId, summarizeLatency(samples)]),
      ),
      ...(latencySha256 ? { sha256: latencySha256 } : {}),
    };
    const completedAt = new Date().toISOString();
    const integrityPayload = JSON.stringify({
      ...manifest,
      audioTracks,
      transcripts,
      latencyReport,
      completedAt,
    });
    const finalized: ArchiveManifest = {
      ...manifest,
      audioTracks,
      transcripts,
      latencyReport,
      completedAt,
      integritySha256: createHash('sha256').update(integrityPayload).digest('hex'),
    };
    await this.#writeManifest(finalized);
    this.#database
      .prepare('UPDATE archives SET completed_at = ? WHERE session_id = ?')
      .run(completedAt, sessionId);
    return finalized;
  }

  async list(): Promise<ArchiveManifest[]> {
    const rows = this.#database
      .prepare('SELECT session_id FROM archives ORDER BY created_at DESC')
      .all() as Array<{ session_id: string }>;
    return Promise.all(rows.map((row) => this.#readManifest(row.session_id)));
  }

  async retain(sessionId: string, retained: boolean): Promise<ArchiveManifest> {
    const manifest = { ...(await this.#readManifest(sessionId)), retained };
    await this.#writeManifest(manifest);
    this.#database
      .prepare('UPDATE archives SET retained = ? WHERE session_id = ?')
      .run(retained ? 1 : 0, sessionId);
    return manifest;
  }

  async delete(sessionId: string): Promise<void> {
    assertSafeId(sessionId);
    await rm(this.#sessionRoot(sessionId), { recursive: true, force: true });
    this.#database.prepare('DELETE FROM archives WHERE session_id = ?').run(sessionId);
  }

  async purgeExpired(now = new Date()): Promise<string[]> {
    const rows = this.#database
      .prepare('SELECT session_id FROM archives WHERE retained = 0 AND retention_deadline <= ?')
      .all(now.toISOString()) as Array<{ session_id: string }>;
    for (const row of rows) {
      await this.delete(row.session_id);
    }
    return rows.map((row) => row.session_id);
  }

  async readAudioTrack(
    sessionId: string,
    channelId: string,
  ): Promise<{ data: Buffer; filename: string }> {
    assertSafeId(sessionId);
    assertSafeId(channelId);
    const manifest = await this.#readManifest(sessionId);
    const track = manifest.audioTracks.find((candidate) => candidate.channelId === channelId);
    if (!track) throw new Error('Archive audio track not found.');
    try {
      return {
        data: await readFile(path.join(this.#sessionRoot(sessionId), track.path)),
        filename: `${sessionId}-${track.language}.opus`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Archive audio track not found.');
      }
      throw error;
    }
  }

  async readTranscript(
    sessionId: string,
    channelId: string,
  ): Promise<{ data: Buffer; filename: string }> {
    assertSafeId(sessionId);
    assertSafeId(channelId);
    const manifest = await this.#readManifest(sessionId);
    const transcript = manifest.transcripts.find((candidate) => candidate.channelId === channelId);
    if (!transcript) throw new Error('Archive transcript not found.');
    try {
      return {
        data: await readFile(path.join(this.#sessionRoot(sessionId), transcript.path)),
        filename: `${sessionId}-${transcript.language}.jsonl`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Archive transcript not found.');
      }
      throw error;
    }
  }

  async readLatency(sessionId: string): Promise<{ data: Buffer; filename: string }> {
    assertSafeId(sessionId);
    const manifest = await this.#readManifest(sessionId);
    try {
      return {
        data: await readFile(path.join(this.#sessionRoot(sessionId), manifest.latencyReport.path)),
        filename: `${sessionId}-latency.jsonl`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Archive latency report not found.');
      }
      throw error;
    }
  }

  #sessionRoot(sessionId: string): string {
    assertSafeId(sessionId);
    return path.join(this.#root, sessionId);
  }

  #manifestPath(sessionId: string): string {
    return path.join(this.#sessionRoot(sessionId), 'manifest.json');
  }

  async #readManifest(sessionId: string): Promise<ArchiveManifest> {
    assertSafeId(sessionId);
    const manifest = JSON.parse(
      await readFile(this.#manifestPath(sessionId), 'utf8'),
    ) as ArchiveManifest;
    return {
      ...manifest,
      latencyReport: manifest.latencyReport ?? {
        path: 'latency.jsonl',
        sampleCount: 0,
        channels: {},
      },
    };
  }

  async #writeManifest(manifest: ArchiveManifest): Promise<void> {
    const destination = this.#manifestPath(manifest.sessionId);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }
}
