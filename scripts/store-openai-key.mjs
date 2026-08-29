#!/usr/bin/env node

import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const envPath = path.resolve(process.argv[2] ?? '.env');
let key = '';
for await (const chunk of process.stdin) key += chunk;
key = key.trim();

if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) {
  throw new Error('Input does not look like an OpenAI API project key.');
}

const stat = await lstat(envPath);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error(`Refusing to replace non-regular environment file: ${envPath}`);
}

const current = await readFile(envPath, 'utf8');
const lines = current.split(/\r?\n/);
let replaced = false;
const updatedLines = lines.map((line) => {
  if (!line.startsWith('OPENAI_API_KEY=')) return line;
  replaced = true;
  return `OPENAI_API_KEY=${key}`;
});
if (!replaced) updatedLines.push(`OPENAI_API_KEY=${key}`);

const temporary = `${envPath}.tmp.${process.pid}`;
try {
  await writeFile(temporary, updatedLines.join('\n'), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(temporary, 0o600);
  await rename(temporary, envPath);
  await chmod(envPath, 0o600);
} catch (error) {
  await unlink(temporary).catch(() => undefined);
  throw error;
}

console.log(`Stored OPENAI_API_KEY in ${envPath} without printing the key.`);
