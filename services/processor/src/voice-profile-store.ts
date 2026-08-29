import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConsentRecord, Language, VoiceProfile } from '@multilinguum/protocol';
import { z } from 'zod';

const createProfileSchema = z.object({
  displayName: z.string().min(1).max(100),
  encryptedSampleLocation: z.string().min(1),
  sampleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  supportedLanguages: z.array(z.enum(['en', 'ru', 'es', 'uk'])).min(1),
  consent: z.object({
    speakerName: z.string().min(1),
    confirmedAt: z.iso.datetime(),
    authorizerName: z.string().min(1),
    permittedUse: z.string().min(1),
    permittedLanguages: z.array(z.enum(['en', 'ru', 'es', 'uk'])).min(1),
    expiresAt: z.iso.datetime().optional(),
    evidenceReference: z.string().min(1),
  }),
});

export type CreateVoiceProfile = z.infer<typeof createProfileSchema>;

export class VoiceProfileStore {
  readonly #root: string;

  constructor(archiveRoot: string) {
    this.#root = path.resolve(archiveRoot, '..', 'voice-profiles');
  }

  async create(input: unknown): Promise<VoiceProfile> {
    const parsed = createProfileSchema.parse(input);
    const id = randomUUID();
    const consent: ConsentRecord = {
      id: randomUUID(),
      speakerName: parsed.consent.speakerName,
      confirmedAt: parsed.consent.confirmedAt,
      authorizerName: parsed.consent.authorizerName,
      permittedUse: parsed.consent.permittedUse,
      permittedLanguages: parsed.consent.permittedLanguages as Language[],
      evidenceReference: parsed.consent.evidenceReference,
      ...(parsed.consent.expiresAt ? { expiresAt: parsed.consent.expiresAt } : {}),
    };
    const profile: VoiceProfile = {
      id,
      displayName: parsed.displayName,
      encryptedSampleLocation: parsed.encryptedSampleLocation,
      sampleSha256: parsed.sampleSha256,
      supportedLanguages: parsed.supportedLanguages as Language[],
      consent,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.#write(profile);
    return profile;
  }

  async get(id: string): Promise<VoiceProfile | undefined> {
    if (!/^[a-f0-9-]{36}$/.test(id)) return undefined;
    try {
      return JSON.parse(
        await readFile(path.join(this.#root, `${id}.json`), 'utf8'),
      ) as VoiceProfile;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<VoiceProfile[]> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.#root)).filter((file) => file.endsWith('.json'));
    const profiles = await Promise.all(
      files.map(
        async (file) =>
          JSON.parse(await readFile(path.join(this.#root, file), 'utf8')) as VoiceProfile,
      ),
    );
    return profiles.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async markReady(id: string): Promise<VoiceProfile> {
    const profile = await this.#required(id);
    if (profile.status === 'revoked') throw new Error('A revoked profile cannot be reactivated.');
    const updated: VoiceProfile = { ...profile, status: 'ready' };
    await this.#write(updated);
    return updated;
  }

  async revoke(id: string): Promise<VoiceProfile> {
    const profile = await this.#required(id);
    const revokedAt = new Date().toISOString();
    const updated: VoiceProfile = {
      ...profile,
      status: 'revoked',
      revokedAt,
      consent: { ...profile.consent, revokedAt },
    };
    await this.#write(updated);
    return updated;
  }

  async #required(id: string): Promise<VoiceProfile> {
    const profile = await this.get(id);
    if (!profile) throw new Error('Voice profile not found.');
    return profile;
  }

  async #write(profile: VoiceProfile): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const destination = path.join(this.#root, `${profile.id}.json`);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }
}
