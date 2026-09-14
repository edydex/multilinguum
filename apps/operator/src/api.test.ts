import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, operatorUrl, subscribe } from './api';
afterEach(() => vi.unstubAllGlobals());
describe('Community operator connection', () => {
  it('preserves the church proxy prefix for authenticated control requests', async () => {
    expect(operatorUrl('/api/capture/audio', 'https://church.example/translation').href).toBe(
      'https://church.example/translation/api/capture/audio',
    );
    expect(operatorUrl('/api/sessions/current', 'http://127.0.0.1:4310').href).toBe(
      'http://127.0.0.1:4310/api/sessions/current',
    );
    const fetcher = vi.fn(async (_input: URL | string | Request, _init?: RequestInit) =>
      Response.json({ health: [] }),
    );
    vi.stubGlobal('fetch', fetcher);
    await api.current({
      baseUrl: 'https://church.example/translation/',
      token: 'scoped-test-token',
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://church.example/translation/api/sessions/current',
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      headers: { authorization: 'Bearer scoped-test-token' },
    });
  });
  it('renews an existing event socket without opening another connection', () => {
    const instances: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      send = vi.fn();
      close = vi.fn();
      constructor(
        readonly url: URL,
        readonly protocol: string,
      ) {
        instances.push(this);
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const subscription = subscribe(
      { baseUrl: 'https://church.example/translation/', token: 'first-lease' },
      vi.fn(),
      vi.fn(),
    );
    instances[0]!.onopen?.();
    subscription.renew('second-lease');
    expect(instances).toHaveLength(1);
    expect(instances[0]!.url.href).toBe('wss://church.example/translation/api/operator/events');
    expect(instances[0]!.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'renew-auth', token: 'second-lease' }),
    );
    subscription();
    expect(instances[0]!.close).toHaveBeenCalledOnce();
  });
});
