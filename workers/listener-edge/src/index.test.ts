import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';

function environment(type: string) {
  return {
    ASSETS: {
      fetch: async () =>
        new Response(type === 'text/html' ? '<html>SPA</html>' : 'export {};', {
          headers: { 'content-type': type },
        }),
    } as unknown as Fetcher,
    PROCESSOR_PUBLIC_ORIGIN: 'https://processor.example',
  };
}

describe('Heritage browser module delivery', () => {
  it('permits another Heritage origin to import the module and its dotted chunk names', async () => {
    for (const name of ['heritage.js', 'livekit-client.esm-abc.js']) {
      const response = await worker.fetch(
        new Request(`https://listener.example/client/${name}`),
        environment('text/javascript'),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
  });
  it('never serves the SPA shell as a missing module or exposes operator routes', async () => {
    const response = await worker.fetch(
      new Request('https://listener.example/client/missing.js'),
      environment('text/html'),
    );
    expect(response.status).toBe(404);
    const operator = await worker.fetch(
      new Request('https://listener.example/api/sessions/current'),
      environment('text/html'),
    );
    expect(operator.status).toBe(404);
  });
});

afterEach(() => vi.unstubAllGlobals());
it('proxies only the bounded public audio route without credentials or archive access', async () => {
  const upstream = vi.fn(
    async () => new Response('RIFF', { headers: { 'content-type': 'audio/wav' } }),
  );
  vi.stubGlobal('fetch', upstream);
  const route =
    '/api/public/audio/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001.wav';
  const response = await worker.fetch(
    new Request('https://listener.example' + route, {
      headers: { authorization: 'private-not-forwarded' },
    }),
    environment('text/html'),
  );
  expect(response.headers.get('content-type')).toBe('audio/wav');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(JSON.stringify(upstream.mock.calls)).not.toContain('private-not-forwarded');
  for (const path of ['/api/archives/private/audio/en', '/api/public/audio/private/file.wav']) {
    expect(
      (await worker.fetch(new Request('https://listener.example' + path), environment('text/html')))
        .status,
    ).toBe(404);
  }
  expect(upstream).toHaveBeenCalledTimes(1);
});
