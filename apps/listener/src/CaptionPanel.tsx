import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Language, TranscriptSegment } from '@multilinguum/protocol';
import {
  captionWordState,
  narratedAnchorSequence,
  visibleCaptionSegments,
  type CaptionTimeline,
} from './caption-timeline';

function CaptionWords({ segment, now }: { segment: TranscriptSegment; now: number }) {
  if (!segment.playout?.words.length) return <>{segment.text}</>;
  const playout = segment.playout;
  return (
    <>
      {playout.words.map((word, index) => {
        const state = captionWordState(
          playout.startAtUnixMs + word.startOffsetMs,
          playout.startAtUnixMs + word.endOffsetMs,
          now,
        );
        return (
          <span
            key={index}
            className={`caption-word ${state}`}
            aria-current={state === 'current' ? 'true' : undefined}
          >
            {word.text}{' '}
          </span>
        );
      })}
    </>
  );
}

export function CaptionPanel({
  caption,
  language,
  narrated,
  clockOffsetMs,
}: {
  caption: CaptionTimeline | undefined;
  language: Language | undefined;
  narrated: boolean;
  clockOffsetMs: number;
}) {
  const [clock, setClock] = useState(Date.now());
  const [following, setFollowing] = useState(true);
  const [visible, setVisible] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const segments = useRef(new Map<number, HTMLParagraphElement>());
  const follow = useRef(true);
  const programmaticUntil = useRef(0);
  useEffect(() => {
    if (!narrated) return;
    const update = () => setClock(Date.now() + clockOffsetMs);
    update();
    const timer = window.setInterval(update, 80);
    return () => window.clearInterval(timer);
  }, [narrated, clockOffsetMs]);
  const final = useMemo(
    () => (narrated ? visibleCaptionSegments(caption?.final ?? [], clock) : (caption?.final ?? [])),
    [caption?.final, clock, narrated],
  );
  const anchor = narrated ? narratedAnchorSequence(final, clock) : final.at(-1)?.sequence;
  const scroll = useCallback(() => {
    if (!viewport.current) return;
    const target = anchor === undefined ? undefined : segments.current.get(anchor);
    programmaticUntil.current = Date.now() + 500;
    viewport.current.scrollTo({
      top: target
        ? Math.max(0, target.offsetTop - viewport.current.clientHeight * 0.4)
        : viewport.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [anchor]);
  useLayoutEffect(() => {
    if (follow.current) scroll();
  }, [anchor, language, visible, scroll]);
  useEffect(() => {
    follow.current = true;
    setFollowing(true);
  }, [language, caption?.sessionId]);
  return (
    <section className={`captions ${visible ? '' : 'collapsed'}`}>
      <div className="caption-title">
        <strong>Live text {language ? `· ${language.toUpperCase()}` : ''}</strong>
        <div>
          {!following && (
            <button
              onClick={() => {
                follow.current = true;
                setFollowing(true);
                scroll();
              }}
            >
              Jump to live
            </button>
          )}
          <button onClick={() => setVisible((value) => !value)}>
            {visible ? 'Hide text' : 'Show text'}
          </button>
        </div>
      </div>
      {visible && (
        <div
          ref={viewport}
          className="caption-viewport"
          tabIndex={0}
          aria-label="Live text history"
          onPointerDown={() => {
            programmaticUntil.current = 0;
          }}
          onWheel={() => {
            programmaticUntil.current = 0;
          }}
          onScroll={() => {
            const element = viewport.current;
            if (!element || Date.now() < programmaticUntil.current) return;
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
            setFollowing(follow.current);
          }}
        >
          <div className="caption-copy" lang={language}>
            {final.map((segment) => (
              <p
                key={`${segment.sessionId}-${segment.sequence}`}
                ref={(element) => {
                  if (element) segments.current.set(segment.sequence, element);
                  else segments.current.delete(segment.sequence);
                }}
              >
                {narrated ? <CaptionWords segment={segment} now={clock} /> : segment.text}
              </p>
            ))}
            {!caption?.final.length && !caption?.live && (
              <p className="caption-placeholder">Text will appear when the speaker begins.</p>
            )}
            {caption?.live && (caption.final.at(-1)?.sequence ?? -1) < caption.live.sequence && (
              <p className="caption-live">{caption.live.text}</p>
            )}
          </div>
          <span className="visually-hidden" role="status">
            {final.at(-1)?.text}
          </span>
        </div>
      )}
    </section>
  );
}
