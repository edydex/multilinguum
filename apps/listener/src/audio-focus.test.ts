import { describe, expect, it } from 'vitest';
import { AudioFocus } from './audio-focus';

describe('audio source changes', () => {
  it('stops translated audio before unmuting YouTube', async () => {
    const events: string[] = [];
    const focus = new AudioFocus({
      stopTranslation: () => {
        events.push('stop');
      },
      muteOriginal: async () => true,
      unmuteOriginal: () => {
        events.push('unmute');
      },
      startTranslation: async () => {},
      changed: () => {},
      failed: () => {},
    });
    await focus.choose('original');
    expect(events).toEqual(['stop', 'unmute']);
  });
  it('does not start a translation after a newer choice while mute confirmation is pending', async () => {
    let confirm!: (value: boolean) => void;
    const starts: string[] = [];
    const focus = new AudioFocus({
      stopTranslation: () => {},
      muteOriginal: () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
      unmuteOriginal: () => {},
      startTranslation: async (language) => {
        starts.push(language);
      },
      changed: () => {},
      failed: () => {},
    });
    const pending = focus.choose('ru');
    await focus.choose('original');
    confirm(true);
    await pending;
    expect(starts).toEqual([]);
  });
  it('stays silent if the original player cannot confirm muting', async () => {
    const events: string[] = [];
    const focus = new AudioFocus({
      stopTranslation: () => {},
      muteOriginal: async () => false,
      unmuteOriginal: () => {},
      startTranslation: async () => {
        events.push('start');
      },
      changed: () => {},
      failed: () => {
        events.push('failed');
      },
    });
    await focus.choose('ru');
    expect(events).toEqual(['failed']);
  });
});
