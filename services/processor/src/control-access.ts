import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';

const lifetimeMs = 10 * 60 * 1000;
const prefix = 'mlg1';
export interface ControlAccess {
  subject: string;
  expiresAtUnixMs: number;
  scope: 'master' | 'session-control';
}
interface Claims {
  subject: string;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
  scope: 'session-control';
  audience: 'multilinguum-control-v1';
  id: string;
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${prefix}.${payload}`).digest('base64url');
}
export function issueControlLease(subject: string, secret: string, now = Date.now()) {
  if (!subject || subject.length > 128 || secret.length < 32)
    throw new Error('Invalid lease configuration');
  const claims: Claims = {
    subject,
    issuedAtUnixMs: now,
    expiresAtUnixMs: now + lifetimeMs,
    scope: 'session-control',
    audience: 'multilinguum-control-v1',
    id: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return {
    token: `${prefix}.${payload}.${sign(payload, secret)}`,
    expiresAtUnixMs: claims.expiresAtUnixMs,
  };
}
export function readControlAccess(
  token: string,
  secret: string,
  now = Date.now(),
): ControlAccess | undefined {
  if (equal(token, secret))
    return { subject: 'processor-master', scope: 'master', expiresAtUnixMs: Infinity };
  if (token.length > 2048) return;
  const [version, payload, signature, extra] = token.split('.');
  if (
    version !== prefix ||
    !payload ||
    !signature ||
    extra !== undefined ||
    !equal(sign(payload, secret), signature)
  )
    return;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Claims;
    if (
      claims.audience !== 'multilinguum-control-v1' ||
      claims.scope !== 'session-control' ||
      typeof claims.subject !== 'string' ||
      !claims.subject ||
      claims.subject.length > 128 ||
      !Number.isSafeInteger(claims.issuedAtUnixMs) ||
      !Number.isSafeInteger(claims.expiresAtUnixMs) ||
      claims.issuedAtUnixMs > now + 5000 ||
      claims.expiresAtUnixMs <= now ||
      claims.expiresAtUnixMs - claims.issuedAtUnixMs > lifetimeMs ||
      claims.expiresAtUnixMs <= claims.issuedAtUnixMs
    )
      return;
    return {
      subject: claims.subject,
      scope: claims.scope,
      expiresAtUnixMs: claims.expiresAtUnixMs,
    };
  } catch {
    return;
  }
}

/** Renew an existing stream without interrupting its capture pipeline. */
export function bindSocketAccess(socket: WebSocket, initial: ControlAccess, secret: string) {
  let access = initial;
  let invalidated = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(expiry);
    if (Number.isFinite(access.expiresAtUnixMs))
      expiry = setTimeout(
        () => socket.close(1008, 'Control access expired; sign in again'),
        Math.max(0, access.expiresAtUnixMs - Date.now()),
      );
  };
  arm();
  socket.on('close', () => {
    invalidated = true;
    clearTimeout(expiry);
  });
  return {
    valid: () => !invalidated && access.expiresAtUnixMs > Date.now(),
    consume(message: RawData, binary: boolean) {
      if (binary) return false;
      try {
        const raw = message.toString();
        if (raw.length > 4096) throw new Error('Oversized auth message');
        const value = JSON.parse(raw) as { type?: string; token?: string };
        if (value.type !== 'renew-auth') return false;
        const next =
          typeof value.token === 'string' ? readControlAccess(value.token, secret) : undefined;
        if (
          invalidated ||
          !next ||
          next.subject !== access.subject ||
          next.scope !== access.scope ||
          access.expiresAtUnixMs <= Date.now()
        )
          throw new Error('Invalid renewal');
        access = next;
        arm();
        socket.send(
          JSON.stringify({
            type: 'auth-renewed',
            expiresAtUnixMs: Number.isFinite(access.expiresAtUnixMs)
              ? access.expiresAtUnixMs
              : null,
          }),
        );
      } catch {
        invalidated = true;
        clearTimeout(expiry);
        socket.close(1008, 'Control access renewal failed');
      }
      return true;
    },
  };
}
