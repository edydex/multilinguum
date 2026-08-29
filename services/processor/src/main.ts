import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const server = await buildServer(config);

try {
  await server.listen({ host: config.PROCESSOR_HOST, port: config.PROCESSOR_PORT });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
