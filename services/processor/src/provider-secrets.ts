import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

type MuseSecret = { apiKey: string; verifiedAt: string };

/** The encryption key is derived from the processor master credential, never stored with the ciphertext. */
export class ProviderSecrets {
  readonly #root: string;
  readonly #key: Buffer;
  constructor(archiveRoot: string, masterCredential: string) {
    this.#root = path.join(path.resolve(archiveRoot), 'private-provider-settings');
    this.#key = Buffer.from(
      hkdfSync('sha256', masterCredential, 'multilinguum-provider-secrets-v1', 'muse-token', 32),
    );
  }
  async readMuse(): Promise<MuseSecret | undefined> {
    let source: string;
    try {
      source = await readFile(path.join(this.#root, 'muse.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('The saved Muse credential could not be read.');
    }
    try {
      const envelope = JSON.parse(source) as {
        version: number;
        iv: string;
        tag: string;
        ciphertext: string;
      };
      if (envelope.version !== 1) throw new Error('Version');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from('multilinguum:muse:v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      ) as MuseSecret;
      if (
        typeof value.apiKey !== 'string' ||
        value.apiKey.length < 16 ||
        !Number.isFinite(Date.parse(value.verifiedAt))
      )
        throw new Error('Data');
      return value;
    } catch {
      throw new Error(
        'The saved Muse credential could not be decrypted. Restore the matching processor master credential or reconfigure the token.',
      );
    }
  }
  async writeMuse(value: MuseSecret): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from('multilinguum:muse:v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const temporary = path.join(this.#root, `.muse-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: encrypted.toString('base64'),
        }),
        { mode: 0o600, flag: 'wx' },
      );
      await rename(temporary, path.join(this.#root, 'muse.json'));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async removeMuse(): Promise<void> {
    await rm(path.join(this.#root, 'muse.json'), { force: true });
  }
}
