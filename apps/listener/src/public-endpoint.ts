/** A deployment may live under /translation/, not only at the origin root. */
export function publicEndpoint(
  base: string,
  endpoint: 'service' | 'events' | 'token' | `audio/${string}/${string}.wav`,
): URL {
  const root = new URL(base.endsWith('/') ? base : `${base}/`, window.location.href);
  return new URL(`api/public/${endpoint}`, root);
}
