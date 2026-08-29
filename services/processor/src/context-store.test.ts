import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SermonContextStore } from './context-store.js';

describe('SermonContextStore', () => {
  it('stores private notes and retrieves the passage relevant to the spoken text', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'multilinguum-context-'));
    const store = new SermonContextStore(root);
    const document = await store.create(
      'Sunday sermon.txt',
      'text/plain',
      new TextEncoder().encode(
        [
          'Opening announcements and service details.',
          'Ефесянам 4:3. Старайтесь сохранять единство Духа в союзе мира.\n' +
            'Ephesians 4:3. Be diligent to preserve the unity of the Spirit in the bond of peace.',
          'Closing application about patience and love.',
        ].join('\n\n'),
      ),
    );

    expect(document.characterCount).toBeGreaterThan(100);
    const results = await store.retrieve(
      [document.id],
      'Именно поэтому мы должны сохранять единство Духа.',
      1,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('Ephesians 4:3');
    await expect(store.require([document.id])).resolves.toBeUndefined();
  });
});
