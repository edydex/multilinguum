import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ContextDocument } from '@multilinguum/protocol';

const execFileAsync = promisify(execFile);
const maximumCharacters = 500_000;

function words(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
      (word) => !/^\d+$/u.test(word) || word.length >= 4,
    ),
  );
}

function chunks(value: string, maximumLength = 1_800): string[] {
  const paragraphs = value
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const output: string[] = [];
  let pending = '';
  for (const paragraph of paragraphs) {
    if (pending && pending.length + paragraph.length + 2 > maximumLength) {
      output.push(pending);
      pending = '';
    }
    if (paragraph.length > maximumLength) {
      if (pending) output.push(pending);
      pending = '';
      for (let offset = 0; offset < paragraph.length; offset += maximumLength) {
        output.push(paragraph.slice(offset, offset + maximumLength));
      }
      continue;
    }
    pending = pending ? `${pending}\n\n${paragraph}` : paragraph;
  }
  if (pending) output.push(pending);
  return output;
}

export class SermonContextStore {
  readonly #root: string;

  constructor(archiveRoot: string) {
    this.#root = path.join(path.resolve(archiveRoot), 'context');
  }

  async create(
    filename: string,
    contentType: ContextDocument['contentType'],
    data: Uint8Array,
  ): Promise<ContextDocument> {
    if (data.byteLength === 0 || data.byteLength > 10 * 1024 * 1024) {
      throw new Error('Sermon notes must be between 1 byte and 10 MB.');
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const extension = contentType === 'application/pdf' ? 'pdf' : 'txt';
    const originalPath = path.join(this.#root, `${id}.${extension}`);
    await writeFile(originalPath, data, { mode: 0o600 });
    let text: string;
    try {
      if (contentType === 'application/pdf') {
        if (!Buffer.from(data.slice(0, 5)).equals(Buffer.from('%PDF-'))) {
          throw new Error('The uploaded file is not a valid PDF.');
        }
        const result = await execFileAsync('pdftotext', ['-layout', originalPath, '-'], {
          maxBuffer: 12 * 1024 * 1024,
        });
        text = result.stdout;
      } else {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      }
    } catch (error) {
      await rm(originalPath, { force: true });
      throw error;
    }
    text = text.replace(/\u0000/gu, '').trim();
    if (!text) {
      await rm(originalPath, { force: true });
      throw new Error('No readable text was found in the sermon notes.');
    }
    if (text.length > maximumCharacters) text = text.slice(0, maximumCharacters);
    const document: ContextDocument = {
      id,
      filename: filename.trim().slice(0, 180) || `sermon-notes.${extension}`,
      contentType,
      sha256: createHash('sha256').update(data).digest('hex'),
      uploadedAt: new Date().toISOString(),
      characterCount: text.length,
    };
    await Promise.all([
      writeFile(path.join(this.#root, `${id}.extracted.txt`), text, { mode: 0o600 }),
      writeFile(path.join(this.#root, `${id}.json`), JSON.stringify(document, null, 2), {
        mode: 0o600,
      }),
    ]);
    return document;
  }

  async list(): Promise<ContextDocument[]> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const files = await readdir(this.#root);
    const documents = await Promise.all(
      files
        .filter((file) => /^[0-9a-f-]{36}\.json$/u.test(file))
        .map(
          async (file) =>
            JSON.parse(await readFile(path.join(this.#root, file), 'utf8')) as ContextDocument,
        ),
    );
    return documents.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt));
  }

  async require(documentIds: readonly string[]): Promise<void> {
    const available = new Set((await this.list()).map((document) => document.id));
    const missing = documentIds.filter((id) => !available.has(id));
    if (missing.length > 0)
      throw new Error('One or more selected sermon-note files are unavailable.');
  }

  async retrieve(
    documentIds: readonly string[],
    query: string,
    maximumResults = 4,
  ): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const documents = new Map((await this.list()).map((document) => [document.id, document]));
    const queryWords = words(query);
    const candidates: Array<{ text: string; score: number; order: number }> = [];
    let order = 0;
    for (const id of documentIds) {
      const document = documents.get(id);
      if (!document) continue;
      const text = await readFile(path.join(this.#root, `${id}.extracted.txt`), 'utf8');
      for (const chunk of chunks(text)) {
        const chunkWords = words(chunk);
        let score = 0;
        for (const word of queryWords) if (chunkWords.has(word)) score += 1;
        candidates.push({
          text: `[${document.filename}]\n${chunk}`,
          score,
          order: order++,
        });
      }
    }
    return candidates
      .sort((left, right) => right.score - left.score || left.order - right.order)
      .slice(0, maximumResults)
      .map((candidate) => candidate.text);
  }
}
