import { readFile, writeFile } from 'node:fs/promises';

const [whisperPath, transcriptPath, latencyPath, outputPath] = process.argv.slice(2);
if (!whisperPath || !transcriptPath || !latencyPath || !outputPath) {
  throw new Error(
    'Usage: node scripts/align-whisper-review-track.mjs <whisper.json> <transcript.jsonl> <latency.jsonl> <output.json>',
  );
}

const parseJsonl = (value) =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(JSON.parse);

const [whisper, transcriptText, latencyText] = await Promise.all([
  readFile(whisperPath, 'utf8').then(JSON.parse),
  readFile(transcriptPath, 'utf8'),
  readFile(latencyPath, 'utf8'),
]);
const transcript = parseJsonl(transcriptText)
  .filter((segment) => segment.final)
  .sort((left, right) => left.sequence - right.sequence);
const durations = new Map(
  parseJsonl(latencyText)
    .filter((sample) => sample.channelId === 'channel-en' && sample.playout)
    .map((sample) => [
      sample.sequence,
      sample.playout.completedAtUnixMs - sample.playout.startedAtUnixMs,
    ]),
);
const measuredWords = (whisper.segments ?? []).flatMap((segment) =>
  (segment.words ?? [])
    .map((word) => ({
      text: String(word.word ?? '').trim(),
      audioStartMs: Math.max(0, Math.round(Number(word.start) * 1_000)),
      audioEndMs: Math.max(0, Math.round(Number(word.end) * 1_000)),
      probability: Number(word.probability),
    }))
    .filter(
      (word) =>
        word.text &&
        Number.isFinite(word.audioStartMs) &&
        Number.isFinite(word.audioEndMs) &&
        word.audioEndMs > word.audioStartMs,
    ),
);

let cursor = 0;
const segments = transcript.map((segment) => {
  const duration = durations.get(segment.sequence);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Missing playout duration for sequence ${segment.sequence}.`);
  }
  const audioStartMs = cursor;
  const audioEndMs = cursor + duration;
  cursor = audioEndMs;
  let words = measuredWords.filter((word) => {
    const midpoint = (word.audioStartMs + word.audioEndMs) / 2;
    return midpoint >= audioStartMs && midpoint < audioEndMs;
  });
  if (words.length === 0) {
    const tokens = segment.text.trim().split(/\s+/u).filter(Boolean);
    words = tokens.map((text, index) => ({
      text,
      audioStartMs: Math.round(audioStartMs + (duration * index) / tokens.length),
      audioEndMs: Math.round(audioStartMs + (duration * (index + 1)) / tokens.length),
      probability: 0,
    }));
  }
  return {
    ...segment,
    audioStartMs,
    audioEndMs,
    words,
  };
});

// Whisper can place a boundary word a few milliseconds across the archived
// chunk edge. Make neighboring review segments contiguous at the midpoint
// between the measured last and first words so seeking that word activates the
// correct caption line without discarding the measured speech time.
for (let index = 0; index < segments.length - 1; index += 1) {
  const current = segments[index];
  const next = segments[index + 1];
  const lastWord = current.words.at(-1);
  const firstWord = next.words[0];
  if (!lastWord || !firstWord) continue;
  const boundary = Math.max(
    current.audioStartMs + 1,
    Math.min(next.audioEndMs - 1, Math.round((lastWord.audioEndMs + firstWord.audioStartMs) / 2)),
  );
  current.audioEndMs = boundary;
  next.audioStartMs = boundary;
}

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      version: 1,
      language: whisper.language,
      source: 'openai-whisper word_timestamps aligned to archived narration chunks',
      segments,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Wrote ${segments.length} segments and ${segments.flatMap((segment) => segment.words).length} measured words over ${cursor} ms.`,
);
