import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/** Only the built public module and its flat JS chunks are served; no SPA fallback. */
export function registerListenerClient(
  app: FastifyInstance,
  directory = fileURLToPath(new URL('../client/', import.meta.url)),
) {
  app.get('/client/:file', { config: { cors: { origin: '*' } } }, async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js$/.test(file))
      return reply.code(404).send({ error: 'Not found' });
    try {
      const body = await readFile(join(directory, file));
      return reply
        .header('content-type', 'text/javascript; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .header(
          'cache-control',
          ['heritage.js', 'operator.js', 'pcm-worklet.js'].includes(file)
            ? 'no-store'
            : 'public, max-age=31536000, immutable',
        )
        .send(body);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
        return reply.code(404).send({ error: 'Listener client is not installed' });
      throw cause;
    }
  });
}
