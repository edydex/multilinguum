import { readFile, writeFile } from 'node:fs/promises';

const [inputPath, outputPath, cutoffArgument] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error(
    'Usage: node scripts/convert-whisper-review-timings.mjs <whisper.json> <review.json> [cutoff-ms]',
  );
}

const cutoffMs = cutoffArgument ? Number(cutoffArgument) : Number.POSITIVE_INFINITY;
if (!Number.isFinite(cutoffMs) && cutoffArgument) {
  throw new Error(`Invalid cutoff: ${cutoffArgument}`);
}

const whisper = JSON.parse(await readFile(inputPath, 'utf8'));
const segments = (whisper.segments ?? []).flatMap((segment, sequence) => {
  const words = (segment.words ?? [])
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
        word.audioStartMs < cutoffMs,
    );
  if (words.length === 0) return [];
  return [
    {
      sequence,
      text: words.map((word) => word.text).join(' '),
      audioStartMs: Math.min(...words.map((word) => word.audioStartMs)),
      audioEndMs: Math.max(...words.map((word) => word.audioEndMs)),
      words,
    },
  ];
});

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      version: 1,
      language: whisper.language,
      source: 'openai-whisper word_timestamps',
      segments,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Wrote ${segments.length} segments and ${segments.flatMap((segment) => segment.words).length} words.`,
);
