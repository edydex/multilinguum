import { describe, expect, it, vi } from 'vitest';
import type { Language, MediaRelay, ServiceSession } from '@multilinguum/protocol';
import { SessionMediaRelay } from './session-media-relay.js';

function fixture(name: string) {
  let notify: (language: Language, count: number) => void = () => {};
  const unsubscribe = vi.fn();
  const delegate: MediaRelay = {
    name,
    onListenerCount: (listener) => {
      notify = listener;
      return unsubscribe;
    },
    createSession: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    publishChannel: vi.fn(async (c) => ({ channelId: c.id, roomName: name, trackName: c.id })),
    publishCaption: vi.fn(async () => {}),
    publishAudio: vi.fn(async () => {}),
    audioBacklogMs: () => 0,
    clearAudio: vi.fn(),
  };
  return { delegate, unsubscribe, notify: (count: number) => notify('en', count) };
}

describe('per-service relay lifecycle', () => {
  it('forwards current listener counts and ignores callbacks or closes from a previous service', async () => {
    const first = fixture('first');
    const second = fixture('second');
    const select = vi.fn().mockReturnValueOnce(first.delegate).mockReturnValueOnce(second.delegate);
    const relay = new SessionMediaRelay(select);
    const counts = vi.fn();
    const remove = relay.onListenerCount(counts);
    await relay.createSession({ id: 'first' } as ServiceSession);
    first.notify(1);
    expect(counts).toHaveBeenLastCalledWith('en', 1);
    await expect(relay.createSession({ id: 'second' } as ServiceSession)).rejects.toThrow(
      'already active',
    );
    await relay.closeSession('first');
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    await relay.createSession({ id: 'second' } as ServiceSession);
    second.notify(2);
    first.notify(99);
    expect(counts).toHaveBeenCalledTimes(2);
    expect(counts).toHaveBeenLastCalledWith('en', 2);
    await relay.closeSession('first');
    expect(second.delegate.closeSession).not.toHaveBeenCalled();
    expect(relay.name).toBe('second');
    remove();
    second.notify(3);
    expect(counts).toHaveBeenCalledTimes(2);
    await relay.closeSession('second');
    expect(second.unsubscribe).toHaveBeenCalledOnce();
  });

  it('releases a failed setup before the next service can select its transport', async () => {
    const first = fixture('failed');
    const second = fixture('ready');
    vi.mocked(first.delegate.createSession).mockRejectedValue(new Error('setup failed'));
    const select = vi.fn().mockReturnValueOnce(first.delegate).mockReturnValueOnce(second.delegate);
    const relay = new SessionMediaRelay(select);
    await expect(relay.createSession({ id: 'first' } as ServiceSession)).rejects.toThrow(
      'setup failed',
    );
    expect(first.delegate.closeSession).toHaveBeenCalledWith('first');
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    await relay.createSession({ id: 'second' } as ServiceSession);
    expect(relay.name).toBe('ready');
    await relay.closeSession('second');
  });
});
