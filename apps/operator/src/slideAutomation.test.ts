import { expect, it } from 'vitest';
import { SlideAutomation, type SlideTranslationCommand } from './slideAutomation';

const command = (
  phase: SlideTranslationCommand['phase'],
  segmentId = 'cue-one',
): SlideTranslationCommand => ({
  phase,
  segmentId,
  serviceId: 'sunday',
  serviceRevision: 'a'.repeat(64),
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const events: string[] = [];
  const status: string[] = [];
  let n = 0;
  const io = {
    prepare: async () => {
      events.push('prepare');
      return `session-${++n}`;
    },
    ready: async () => {
      events.push('ready');
    },
    start: async (id: string) => {
      events.push(`start:${id}`);
    },
    stop: async (id: string) => {
      events.push(`stop:${id}`);
    },
    disconnect: () => {
      events.push('disconnect');
    },
    report: (value: { phase: string }) => {
      status.push(value.phase);
    },
  };
  return { events, status, io };
}
it('prepares ahead without starting, starts once, and stops only its own session', async () => {
  const f = fixture(),
    controller = new SlideAutomation(f.io);
  controller.command(command('prepare'));
  await tick();
  expect(f.events).toEqual(['prepare', 'ready']);
  expect(f.status.at(-1)).toBe('ready');
  controller.command(command('live'));
  await tick();
  controller.command(command('live'));
  await tick();
  expect(f.events.filter((event) => event.startsWith('start'))).toEqual(['start:session-1']);
  controller.command(command('idle'));
  await tick();
  expect(f.events).toContain('stop:session-1');
  expect(f.status.at(-1)).toBe('idle');
});
it('a Stop during slow creation never starts, and cleans up the eventual prepared session', async () => {
  const f = fixture();
  let created!: (id: string) => void;
  f.io.prepare = () =>
    new Promise((resolve) => {
      created = resolve;
    });
  const controller = new SlideAutomation(f.io);
  controller.command(command('live'));
  controller.command(command('idle'));
  created('owned');
  await tick();
  expect(f.events).toEqual(['disconnect', 'stop:owned', 'disconnect']);
});
it('a later Start arriving during prewarm uses that same prepared session', async () => {
  const f = fixture();
  let ready!: () => void;
  f.io.ready = () =>
    new Promise<void>((resolve) => {
      ready = resolve;
    });
  const controller = new SlideAutomation(f.io);
  controller.command(command('prepare'));
  await tick();
  controller.command(command('live'));
  ready();
  await tick();
  expect(f.events).toEqual(['prepare', 'start:session-1']);
});
it('failure is visible, rolls back ownership, and can be retried', async () => {
  const f = fixture();
  f.io.ready = async () => {
    throw new Error('Input disconnected');
  };
  const controller = new SlideAutomation(f.io);
  controller.command(command('live'));
  await tick();
  expect(f.status.at(-1)).toBe('error');
  expect(f.events).toContain('stop:session-1');
  f.io.ready = async () => {};
  controller.command(command('live'));
  await tick();
  expect(f.events).toContain('start:session-2');
});
it('backing up before Start stops the live session and prepares afresh', async () => {
  const f = fixture(),
    controller = new SlideAutomation(f.io);
  controller.command(command('live'));
  await tick();
  controller.command(command('prepare'));
  await tick();
  expect(f.events).toContain('stop:session-1');
  expect(f.status.at(-1)).toBe('ready');
  controller.dispose();
  await tick();
  expect(f.events).toContain('stop:session-2');
});
