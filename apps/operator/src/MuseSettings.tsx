import { useEffect, useState } from 'react';
import { api, type OperatorConnection } from './api';

export interface MuseStatus {
  configured: boolean;
  source: string;
  verifiedAt: string | null;
  error?: string;
}
export interface MuseSettingsAccess {
  read(): Promise<MuseStatus>;
  save(apiKey: string): Promise<MuseStatus>;
  remove(): Promise<MuseStatus>;
}
export function MuseSettings({
  connection,
  access,
  onChanged,
}: {
  connection?: OperatorConnection;
  access?: MuseSettingsAccess;
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<MuseStatus>();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const endpoint =
    access ??
    (connection
      ? {
          read: () => api.museSettings(connection),
          save: (key: string) => api.saveMuseSettings(connection, key),
          remove: () => api.removeMuseSettings(connection),
        }
      : undefined);
  useEffect(() => {
    let cancelled = false;
    setStatus(undefined);
    setToken('');
    setMessage('');
    void endpoint
      ?.read()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        if (!cancelled) setMessage('A processor administrator can configure Muse here.');
      });
    return () => {
      cancelled = true;
    };
  }, [connection?.baseUrl, connection?.token, access]);
  async function update(remove = false) {
    if (!endpoint || busy) return;
    setBusy(true);
    setMessage('');
    try {
      if (connection && !access) {
        const url = new URL(connection.baseUrl);
        if (
          url.protocol !== 'https:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )
          throw new Error('Use HTTPS or a local processor connection before sending an API token.');
      }
      const next = remove ? await endpoint.remove() : await endpoint.save(token.trim());
      setStatus(next);
      setToken('');
      setMessage(
        remove
          ? next.configured
            ? 'Saved token removed. The server’s environment token remains configured.'
            : 'Saved token removed.'
          : 'Token saved. Muse connection verified.',
      );
      onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update Muse.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="panel muse-settings">
      <summary>Muse recognition settings</summary>
      <p className="hint">
        Automatic uses Muse for English when configured. Russian uses OpenAI. Translation and
        optional speech use your selected translation profile.
      </p>
      {status && (
        <p>
          {status.configured ? 'Muse token configured' : 'No Muse token configured'}
          {status.verifiedAt
            ? ` · Connection checked ${new Date(status.verifiedAt).toLocaleString()}`
            : ''}
        </p>
      )}
      {status?.error && <p role="alert">{status.error}</p>}
      <label>
        Muse API token
        <input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={busy || !status}
        />
      </label>
      <p className="hint">
        The token is encrypted on the processor and is never sent back to this screen. Saving checks
        the connection without uploading sermon audio.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={busy || !status || !token.trim()}
        onClick={() => void update()}
      >
        {busy ? 'Checking…' : 'Save and test token'}
      </button>
      {status?.source === 'saved' && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void update(true)}
        >
          Remove saved token
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
