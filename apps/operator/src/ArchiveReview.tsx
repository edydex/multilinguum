import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArchiveManifest,
  Language,
  PipelineLatencySample,
  TranscriptSegment,
} from '@multilinguum/protocol';
import { api, type OperatorConnection } from './api';
import {
  activeWordIndex,
  buildDefaultThoughtAnchors,
  buildReviewTrack,
  parseJsonLines,
  sourceTimeAtAudio,
  thoughtAlignedAudioTime,
  thoughtAnchorAtSource,
  wordAudioTime,
  type ReviewSegment,
  type ReviewTrack,
} from './archiveReviewModel';

interface ArchiveReviewProps {
  archive: ArchiveManifest;
  connection: OperatorConnection;
  onClose: () => void;
  onError: (message: string) => void;
}

const reviewLanguages: Language[] = ['en', 'ru'];

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function words(segment: ReviewSegment): string[] {
  return segment.text.trim().split(/\s+/).filter(Boolean);
}

export function ArchiveReview({ archive, connection, onClose, onError }: ArchiveReviewProps) {
  const [tracks, setTracks] = useState<Partial<Record<Language, ReviewTrack>>>({});
  const [language, setLanguage] = useState<Language>('en');
  const [loading, setLoading] = useState(true);
  const [audioMs, setAudioMs] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<{ audioMs: number; play: boolean } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    const load = async () => {
      setLoading(true);
      try {
        const latency = archive.latencyReport.sha256
          ? parseJsonLines<PipelineLatencySample>(
              await (await api.archiveLatency(connection, archive.sessionId)).text(),
            )
          : [];
        const loaded = await Promise.all(
          reviewLanguages.map(async (nextLanguage) => {
            const audioTrack = archive.audioTracks.find(
              (track) => track.language === nextLanguage && track.sha256,
            );
            const transcriptTrack = archive.transcripts.find(
              (track) => track.language === nextLanguage && track.sha256,
            );
            if (!audioTrack || !transcriptTrack) return undefined;
            const [audio, transcriptBlob] = await Promise.all([
              api.archiveAudio(connection, archive.sessionId, audioTrack.channelId),
              api.archiveTranscript(connection, archive.sessionId, transcriptTrack.channelId),
            ]);
            const audioUrl = URL.createObjectURL(audio);
            urls.push(audioUrl);
            return buildReviewTrack(
              nextLanguage,
              audioTrack.channelId,
              audioUrl,
              parseJsonLines<TranscriptSegment>(await transcriptBlob.text()),
              latency,
              archive.sourceLanguage,
            );
          }),
        );
        if (cancelled) return;
        const nextTracks = Object.fromEntries(
          loaded
            .filter((track): track is ReviewTrack => Boolean(track))
            .map((track) => [track.language, track]),
        ) as Partial<Record<Language, ReviewTrack>>;
        setTracks(nextTracks);
        setLanguage(nextTracks.en ? 'en' : archive.sourceLanguage);
        setAudioMs(0);
      } catch (cause) {
        if (!cancelled) onError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [archive, connection, onError]);

  const activeTrack = tracks[language];
  const thoughtAnchors = useMemo(
    () => buildDefaultThoughtAnchors(tracks.en?.segments ?? []),
    [tracks.en],
  );
  const activeSegment = useMemo(() => {
    if (!activeTrack) return undefined;
    return (
      activeTrack.segments.find(
        (segment) => audioMs >= segment.audioStartMs && audioMs < segment.audioEndMs,
      ) ?? [...activeTrack.segments].reverse().find((segment) => audioMs >= segment.audioStartMs)
    );
  }, [activeTrack, audioMs]);
  const sourceMs = activeTrack ? sourceTimeAtAudio(activeTrack, audioMs) : 0;
  const activeThought = thoughtAnchorAtSource(thoughtAnchors, sourceMs);

  const applyPendingSeek = () => {
    const audio = audioRef.current;
    const pending = pendingSeek.current;
    if (!audio || !pending) return;
    audio.currentTime = pending.audioMs / 1_000;
    setAudioMs(pending.audioMs);
    pendingSeek.current = undefined;
    if (pending.play) void audio.play().catch(() => undefined);
  };

  const switchLanguage = (nextLanguage: Language) => {
    const currentTrack = activeTrack;
    const nextTrack = tracks[nextLanguage];
    const audio = audioRef.current;
    if (!currentTrack || !nextTrack || nextLanguage === language) return;
    const alignedPosition = thoughtAlignedAudioTime(
      currentTrack,
      nextTrack,
      (audio?.currentTime ?? 0) * 1_000,
      thoughtAnchors,
    );
    pendingSeek.current = {
      audioMs: alignedPosition.audioMs,
      play: Boolean(audio && !audio.paused),
    };
    setLanguage(nextLanguage);
  };

  const seek = (segment: ReviewSegment, wordIndex = 0, wordCount = 1) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextAudioMs = wordAudioTime(segment, wordIndex, wordCount);
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      pendingSeek.current = { audioMs: nextAudioMs, play: true };
      setAudioMs(nextAudioMs);
      return;
    }
    audio.currentTime = nextAudioMs / 1_000;
    setAudioMs(nextAudioMs);
    void audio.play().catch(() => undefined);
  };

  if (loading) {
    return (
      <section className="panel review-page">
        <div className="empty">Preparing bilingual review…</div>
      </section>
    );
  }

  if (!activeTrack) {
    return (
      <section className="panel review-page">
        <button className="review-back" onClick={onClose}>
          ← Recorded services
        </button>
        <div className="empty">
          This archive does not have reviewable English and Russian tracks.
        </div>
      </section>
    );
  }

  return (
    <section className="panel review-page">
      <div className="review-heading">
        <div>
          <button className="review-back" onClick={onClose}>
            ← Recorded services
          </button>
          <p className="eyebrow">BILINGUAL ARCHIVE REVIEW</p>
          <h2>{new Date(archive.createdAt).toLocaleString()}</h2>
          <p>
            Click any word to hear that moment. Language switching keeps the same sermon thought.
          </p>
        </div>
        <div className="review-position">
          <span>Source position</span>
          <strong>{formatTime(sourceMs)}</strong>
          <small>
            of{' '}
            {formatTime(Math.max(0, ...activeTrack.segments.map((segment) => segment.sourceEndMs)))}
          </small>
        </div>
      </div>

      <div className="review-controls">
        <div className="review-language" role="group" aria-label="Review language">
          <button
            className={language === 'en' ? 'active' : ''}
            disabled={!tracks.en}
            onClick={() => switchLanguage('en')}
          >
            <span>EN</span> English translation
          </button>
          <button
            className={language === 'ru' ? 'active' : ''}
            disabled={!tracks.ru}
            onClick={() => switchLanguage('ru')}
          >
            <span>RU</span> Russian original
          </button>
        </div>
        <audio
          key={activeTrack.audioUrl}
          ref={audioRef}
          controls
          src={activeTrack.audioUrl}
          onLoadedMetadata={applyPendingSeek}
          onTimeUpdate={(event) => setAudioMs(event.currentTarget.currentTime * 1_000)}
          onSeeked={(event) => setAudioMs(event.currentTarget.currentTime * 1_000)}
        />
        <div className="review-clock">
          <strong>{formatTime(audioMs)}</strong>
          <span>/ {formatTime(activeTrack.durationMs)}</span>
        </div>
      </div>

      <div className="review-key">
        <span>
          <i className="current" /> currently spoken
        </span>
        <span>
          <i /> click a word to seek
        </span>
        <span>Language switches restart the matching thought.</span>
      </div>

      {activeThought && (
        <div className="review-thought" aria-live="polite">
          <span>Thought anchor</span>
          <strong>{activeThought.label}</strong>
        </div>
      )}

      <div className="review-transcript" aria-label={`${language.toUpperCase()} transcript`}>
        {activeTrack.segments.map((segment) => {
          const tokens = words(segment);
          const isActive = activeSegment?.sequence === segment.sequence;
          const currentWord = isActive ? activeWordIndex(segment, audioMs, tokens.length) : -1;
          return (
            <article
              className={`review-line ${isActive ? 'active' : ''}`}
              key={`${segment.channelId}-${segment.sequence}`}
            >
              <button className="review-time" onClick={() => seek(segment)}>
                {formatTime(segment.audioStartMs)}
              </button>
              <p>
                {tokens.map((token, index) => (
                  <button
                    className={`review-word ${currentWord === index ? 'current' : ''}`}
                    key={`${segment.sequence}-${index}`}
                    onClick={() => seek(segment, index, tokens.length)}
                  >
                    {token}
                  </button>
                ))}
              </p>
              <span className="review-source-time">source {formatTime(segment.sourceStartMs)}</span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
