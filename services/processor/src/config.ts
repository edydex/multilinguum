import { z } from 'zod';

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PROCESSOR_HOST: z.string().default('127.0.0.1'),
  PROCESSOR_PORT: z.coerce.number().int().positive().default(4310),
  PROCESSOR_PUBLIC_URL: z.url().default('http://127.0.0.1:4310'),
  PROCESSOR_CONTROL_TOKEN: z.string().min(32).default('development-control-token-change-me-now'),
  OPERATOR_ALLOWED_ORIGINS: z
    .string()
    .default(
      'tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420',
    )
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ARCHIVE_ROOT: z.string().default('./data/archives'),
  ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  SERVICE_BUDGET_WARNING_USD: z.coerce.number().positive().default(20),
  OPENAI_API_KEY: optionalString,
  OPENAI_TRANSLATE_MODEL: z.string().default('gpt-realtime-translate'),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-live-transcribe'),
  OPENAI_FILE_TRANSCRIBE_MODEL: z.string().default('gpt-4o-transcribe'),
  OPENAI_TEXT_MODEL: z.string().default('gpt-5.6-terra'),
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  LIVEKIT_URL: optionalUrl,
  LIVEKIT_API_KEY: optionalString,
  LIVEKIT_API_SECRET: optionalString,
  VOICE_WORKER_URL: optionalUrl,
  VOICE_WORKER_TOKEN: z.string().min(24).default('development-voice-token-change-me'),
  CHURCH_NAME: z.string().default('Word of Truth'),
});

export type ProcessorConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const config = environmentSchema.parse(environment);
  if (config.NODE_ENV === 'production' && config.PROCESSOR_CONTROL_TOKEN.includes('change-me')) {
    throw new Error('PROCESSOR_CONTROL_TOKEN must be replaced in production.');
  }
  if (config.NODE_ENV === 'production' && config.VOICE_WORKER_TOKEN.includes('change-me')) {
    throw new Error('VOICE_WORKER_TOKEN must be replaced in production.');
  }
  return config;
}
