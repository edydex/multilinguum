import { describe, expect, it, vi } from 'vitest';
import type { ServiceSession } from '@multilinguum/protocol';
import { stopOwnedSession } from './stopOwnedSession';

const session = (id: string, state: ServiceSession['state']) => ({ id, state }) as ServiceSession;
describe('confirmed cue stop', () => {
  it('accepts a completed owned session after a lost Stop response', async () => {
    const completed = session('ours', 'completed');
    const io = {
      current: vi
        .fn()
        .mockResolvedValueOnce({ session: session('ours', 'live') })
        .mockResolvedValue({ session: completed }),
      stop: vi.fn().mockRejectedValue(new Error('500')),
    };
    expect(await stopOwnedSession('ours', io)).toBe(completed);
    expect(io.stop).toHaveBeenCalledExactlyOnceWith('ours');
  });
  it.each(['live', 'stopping', 'failed'] as const)(
    'does not mistake %s for a confirmed stop',
    async (state) => {
      const error = new Error('Stop failed');
      const io = {
        current: vi.fn().mockResolvedValue({ session: session('ours', state) }),
        stop: vi.fn().mockRejectedValue(error),
      };
      await expect(stopOwnedSession('ours', io)).rejects.toBe(error);
    },
  );
  it('does not treat a replacement session as confirmation', async () => {
    const error = new Error('Stop failed');
    const io = {
      current: vi
        .fn()
        .mockResolvedValueOnce({ session: session('ours', 'live') })
        .mockResolvedValue({ session: session('other', 'completed') }),
      stop: vi.fn().mockRejectedValue(error),
    };
    await expect(stopOwnedSession('ours', io)).rejects.toBe(error);
  });
  it('never stops a session owned by somebody else', async () => {
    const io = {
      current: vi.fn().mockResolvedValue({ session: session('other', 'live') }),
      stop: vi.fn(),
    };
    await stopOwnedSession('ours', io);
    expect(io.stop).not.toHaveBeenCalled();
  });
  it('preserves an unconfirmed failure when status cannot be reached', async () => {
    const error = new Error('Stop failed');
    const io = {
      current: vi
        .fn()
        .mockResolvedValueOnce({ session: session('ours', 'live') })
        .mockRejectedValue(new Error('offline')),
      stop: vi.fn().mockRejectedValue(error),
    };
    await expect(stopOwnedSession('ours', io)).rejects.toBe(error);
  });
});
