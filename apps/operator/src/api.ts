import type {
  ArchiveManifest,
  ChannelHealth,
  ProcessorEvent,
  ServiceSession,
  VoiceProfile,
} from '@multilinguum/protocol';

export interface OperatorConnection {
  baseUrl: string;
  token: string;
}

export function controlWebSocketProtocol(token: string): string {
  return `multilinguum-auth.${token}`;
}

async function request<T>(
  connection: OperatorConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(new URL(path, connection.baseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${connection.token}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestBlob(connection: OperatorConnection, path: string): Promise<Blob> {
  const response = await fetch(new URL(path, connection.baseUrl), {
    headers: { authorization: `Bearer ${connection.token}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.blob();
}

async function uploadVoiceSample(
  connection: OperatorConnection,
  profileId: string,
  sample: File,
): Promise<VoiceProfile> {
  const response = await fetch(
    new URL(`/api/voice-profiles/${encodeURIComponent(profileId)}/sample`, connection.baseUrl),
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/octet-stream',
      },
      body: sample,
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as VoiceProfile;
}

export const api = {
  preflight: (connection: OperatorConnection) =>
    request<Record<string, unknown>>(connection, '/api/preflight'),
  current: (connection: OperatorConnection) =>
    request<{ session?: ServiceSession; health: ChannelHealth[] }>(
      connection,
      '/api/sessions/current',
    ),
  create: (connection: OperatorConnection, body: unknown) =>
    request<ServiceSession>(connection, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  start: (connection: OperatorConnection) =>
    request<ServiceSession>(connection, '/api/sessions/current/start', {
      method: 'POST',
      body: '{}',
    }),
  stop: (connection: OperatorConnection) =>
    request<{ session: ServiceSession; archive: ArchiveManifest }>(
      connection,
      '/api/sessions/current/stop',
      { method: 'POST', body: '{}' },
    ),
  channel: (connection: OperatorConnection, channelId: string, body: unknown) =>
    request<ChannelHealth>(connection, `/api/sessions/current/channels/${channelId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  archives: (connection: OperatorConnection) =>
    request<ArchiveManifest[]>(connection, '/api/archives'),
  archiveAudio: (connection: OperatorConnection, sessionId: string, channelId: string) =>
    requestBlob(connection, `/api/archives/${sessionId}/audio/${channelId}`),
  archiveTranscript: (connection: OperatorConnection, sessionId: string, channelId: string) =>
    requestBlob(connection, `/api/archives/${sessionId}/transcripts/${channelId}`),
  archiveLatency: (connection: OperatorConnection, sessionId: string) =>
    requestBlob(connection, `/api/archives/${sessionId}/latency`),
  retain: (connection: OperatorConnection, sessionId: string, retained: boolean) =>
    request<ArchiveManifest>(connection, `/api/archives/${sessionId}/retain`, {
      method: 'POST',
      body: JSON.stringify({ retained }),
    }),
  deleteArchive: (connection: OperatorConnection, sessionId: string) =>
    request<void>(connection, `/api/archives/${sessionId}`, { method: 'DELETE' }),
  voiceProfiles: (connection: OperatorConnection) =>
    request<VoiceProfile[]>(connection, '/api/voice-profiles'),
  createVoiceProfile: (connection: OperatorConnection, body: unknown) =>
    request<VoiceProfile>(connection, '/api/voice-profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  uploadVoiceSample,
  revokeVoiceProfile: (connection: OperatorConnection, profileId: string) =>
    request<VoiceProfile>(connection, `/api/voice-profiles/${profileId}/revoke`, {
      method: 'POST',
      body: '{}',
    }),
};

export function subscribe(
  connection: OperatorConnection,
  onEvent: (event: ProcessorEvent) => void,
  onState: (connected: boolean) => void,
): () => void {
  let stopped = false;
  let retryDelayMs = 1_000;
  let retryTimer: number | undefined;
  let socket: WebSocket | undefined;

  const connect = () => {
    const url = new URL('/api/operator/events', connection.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url, controlWebSocketProtocol(connection.token));
    socket.onopen = () => {
      retryDelayMs = 1_000;
      onState(true);
    };
    socket.onmessage = (message) => onEvent(JSON.parse(String(message.data)) as ProcessorEvent);
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      onState(false);
      if (stopped) return;
      retryTimer = window.setTimeout(connect, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 15_000);
    };
  };

  connect();
  return () => {
    stopped = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    socket?.close();
  };
}
