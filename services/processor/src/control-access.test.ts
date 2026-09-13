import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { bindSocketAccess, issueControlLease, readControlAccess } from './control-access.js';
const secret = 'test-master-secret-with-at-least-32-characters';

describe('short-lived Community control access', () => {
  it('rejects forged, expired, future, and wrong-server leases', () => {
    const { token, expiresAtUnixMs } = issueControlLease('community:1:user:2', secret, 10000);
    expect(readControlAccess(token, secret, 10000)?.scope).toBe('session-control');
    expect(readControlAccess(token, secret, expiresAtUnixMs)).toBeUndefined();
    expect(readControlAccess(token, secret, 0)).toBeUndefined();
    expect(readControlAccess(token, `${secret}other`, 10000)).toBeUndefined();
    expect(readControlAccess(`${token.slice(0, -1)}!`, secret, 10000)).toBeUndefined();
    expect(readControlAccess(secret, secret)?.scope).toBe('master');
  });
  it('renews the same operator without closing a live socket and expires without renewal', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10000);
      const socket = Object.assign(new EventEmitter(), { close: vi.fn(), send: vi.fn() });
      const first = issueControlLease('community:1:user:2', secret);
      const bound = bindSocketAccess(
        socket as unknown as WebSocket,
        readControlAccess(first.token, secret)!,
        secret,
      );
      vi.advanceTimersByTime(120000);
      const next = issueControlLease('community:1:user:2', secret);
      expect(
        bound.consume(
          Buffer.from(JSON.stringify({ type: 'renew-auth', token: next.token })),
          false,
        ),
      ).toBe(true);
      vi.advanceTimersByTime(480001);
      expect(bound.valid()).toBe(true);
      expect(socket.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(120000);
      expect(bound.valid()).toBe(false);
      expect(socket.close).toHaveBeenCalledWith(1008, expect.stringContaining('expired'));
      socket.emit('close');
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    'does not let another identity take over a scoped socket (master=%s)',
    (master) => {
      const socket = Object.assign(new EventEmitter(), { close: vi.fn(), send: vi.fn() });
      const first = issueControlLease('operator-a', secret);
      const bound = bindSocketAccess(
        socket as unknown as WebSocket,
        readControlAccess(first.token, secret)!,
        secret,
      );
      bound.consume(
        Buffer.from(
          JSON.stringify({
            type: 'renew-auth',
            token: master ? secret : issueControlLease('operator-b', secret).token,
          }),
        ),
        false,
      );
      expect(socket.close).toHaveBeenCalledWith(1008, expect.stringContaining('failed'));
      expect(bound.valid()).toBe(false);
      socket.emit('close');
    },
  );
});
