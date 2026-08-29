import { readFile, rename, stat, writeFile } from 'node:fs/promises';

const [targetPath, overlayPath] = process.argv.slice(2);
if (!targetPath || !overlayPath) {
  throw new Error('Usage: node scripts/merge-env-overlay.mjs <target.env> <overlay.env>');
}

const [target, overlay, targetStat] = await Promise.all([
  readFile(targetPath, 'utf8'),
  readFile(overlayPath, 'utf8'),
  stat(targetPath),
]);

const keyPattern = /^([A-Z][A-Z0-9_]*)=/;
const overlayLines = overlay
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean);
const overlayKeys = new Set(
  overlayLines.map((line) => {
    const match = line.match(keyPattern);
    if (!match) throw new Error(`Invalid environment overlay entry for ${overlayPath}.`);
    return match[1];
  }),
);

const retainedLines = target.split(/\r?\n/u).filter((line) => {
  const key = line.match(keyPattern)?.[1];
  return !key || !overlayKeys.has(key);
});
while (retainedLines.at(-1) === '') retainedLines.pop();

const temporaryPath = `${targetPath}.next`;
await writeFile(temporaryPath, `${[...retainedLines, ...overlayLines].join('\n')}\n`, {
  mode: targetStat.mode,
});
await rename(temporaryPath, targetPath);
