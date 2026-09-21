import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderSecrets } from './provider-secrets.js';

describe('encrypted provider credentials', () => {
  it('persists only ciphertext, restricts filesystem permissions, and detects tampering and master-key changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'provider-secrets-'));
    try {
      const value = { apiKey: 'PRIVATE_MUSE_KEY_SENTINEL', verifiedAt: '2026-09-20T12:00:00.000Z' };
      const store = new ProviderSecrets(root, 'a-master-credential-with-sufficient-entropy');
      expect(await store.readMuse()).toBeUndefined();
      await store.writeMuse(value);
      const file = path.join(root, 'private-provider-settings', 'muse.json');
      const ciphertext = await readFile(file, 'utf8');
      expect(ciphertext).not.toContain(value.apiKey);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      expect(
        await new ProviderSecrets(root, 'a-master-credential-with-sufficient-entropy').readMuse(),
      ).toEqual(value);
      await expect(
        new ProviderSecrets(root, 'another-master-credential-with-sufficient-entropy').readMuse(),
      ).rejects.toThrow('could not be decrypted');
      const edited = JSON.parse(ciphertext);
      edited.ciphertext = edited.ciphertext.slice(4);
      await writeFile(file, JSON.stringify(edited));
      await expect(store.readMuse()).rejects.toThrow('could not be decrypted');
      await store.writeMuse(value);
      await store.removeMuse();
      expect(await store.readMuse()).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
