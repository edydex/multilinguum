import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const server = await buildServer(config);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void server.close().catch((error) => {
      server.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await server.listen({ host: config.PROCESSOR_HOST, port: config.PROCESSOR_PORT });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
  await server.close();
}
