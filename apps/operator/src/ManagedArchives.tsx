import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchiveManifest } from '@multilinguum/protocol';
import { api, type OperatorConnection } from './api';
import { ArchiveReview } from './ArchiveReview';
import type { ControlLease } from './ManagedOperator';

function RecordingList({ requestAccess }: { requestAccess: () => Promise<ControlLease> }) {
  const [archives, setArchives] = useState<ArchiveManifest[]>([]);
  const [selected, setSelected] = useState<ArchiveManifest>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const lease = useRef<ControlLease | undefined>(undefined);
  const pending = useRef<Promise<ControlLease> | undefined>(undefined);
  const requestConnection = useCallback(async (): Promise<OperatorConnection> => {
    if (!lease.current || lease.current.expiresAtUnixMs <= Date.now() + 30000) {
      pending.current ??= requestAccess();
      try {
        lease.current = await pending.current;
      } finally {
        pending.current = undefined;
      }
    }
    return { baseUrl: lease.current.apiBase, token: lease.current.token };
  }, [requestAccess]);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setLoading(true);
    setError('');
    lease.current = undefined;
    void requestConnection()
      .then((connection) => {
        if (stopped) return [];
        return api.archives(connection, controller.signal);
      })
      .then((items) => {
        if (!stopped)
          setArchives(
            items
              .filter((item) => item.completedAt)
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
          );
      })
      .catch((cause) => {
        if (!stopped)
          setError(cause instanceof Error ? cause.message : 'Could not load recorded services.');
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [requestConnection, refresh]);

  return (
    <div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {selected ? (
        <ArchiveReview
          archive={selected}
          requestConnection={requestConnection}
          onClose={() => {
            setSelected(undefined);
            setError('');
          }}
          onError={setError}
        />
      ) : (
        <>
          <div className="recording-list-heading">
            <p className="hint">
              Review the original and translated transcript, with audio when it was recorded. These
              recordings are private.
            </p>
            <button disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
              Refresh recordings
            </button>
          </div>
          {loading ? (
            <p role="status">Loading recorded services…</p>
          ) : !error && !archives.length ? (
            <p>No completed recordings yet. Stop a translation session to finish its recording.</p>
          ) : (
            <ul className="recording-list">
              {archives.map((archive) => (
                <li key={archive.sessionId}>
                  <div>
                    <strong>{archive.serviceReference?.title || 'Recorded service'}</strong>
                    <p>
                      {new Date(archive.createdAt).toLocaleString()} ·{' '}
                      {archive.transcripts.filter((track) => track.sha256).length} transcript(s)
                    </p>
                    <small>
                      {archive.retained
                        ? 'Kept indefinitely'
                        : `Available until ${new Date(archive.retentionDeadline).toLocaleDateString()}`}
                    </small>
                  </div>
                  <button
                    onClick={() => {
                      setSelected(archive);
                      setError('');
                    }}
                    aria-label={`Review ${archive.serviceReference?.title || new Date(archive.createdAt).toLocaleString()}`}
                  >
                    Review recording
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function ManagedArchives({ requestAccess }: { requestAccess: () => Promise<ControlLease> }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card managed-archives">
      <div className="recording-list-heading">
        <h2>Recorded services</h2>
        <button aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Close recordings' : 'Browse recordings'}
        </button>
      </div>
      {open && <RecordingList requestAccess={requestAccess} />}
    </section>
  );
}
