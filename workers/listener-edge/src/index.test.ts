import { describe, expect, it } from 'vitest';
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
