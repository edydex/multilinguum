import type { ServiceSession } from '@multilinguum/protocol';

/** A proxy may lose the Stop response after the processor completes the session.
 * Reconcile only a positively confirmed completion of the session we own. */
export async function stopOwnedSession(
  id: string,
  io: {
    current(): Promise<{ session?: ServiceSession }>;
    stop(id: string): Promise<{ session: ServiceSession }>;
  },
): Promise<ServiceSession | undefined> {
  const current = await io.current();
  if (current.session?.id !== id) return;
  if (current.session.state === 'completed') return current.session;
  try {
    return (await io.stop(id)).session;
  } catch (error) {
    // An unavailable status endpoint, a different session, or a nonterminal
    // state cannot prove that stopping succeeded. Preserve the original error.
    const confirmed = await io.current().catch(() => undefined);
    if (confirmed?.session?.id === id && confirmed.session.state === 'completed')
      return confirmed.session;
    throw error;
  }
}
