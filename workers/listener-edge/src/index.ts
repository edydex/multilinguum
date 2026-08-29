interface Environment {
  ASSETS: Fetcher;
  PROCESSOR_PUBLIC_ORIGIN: string;
}

const publicApiPaths = new Set(['/api/public/service', '/api/public/token', '/api/public/events']);

function secureHeaders(headers: Headers): Headers {
  headers.set(
    'content-security-policy',
    "default-src 'self'; connect-src 'self' wss: https:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'",
  );
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(), geolocation=(), microphone=()');
  return headers;
}

async function proxyPublicApi(request: Request, environment: Environment): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const incoming = new URL(request.url);
  const upstream = new URL(
    incoming.pathname + incoming.search,
    environment.PROCESSOR_PUBLIC_ORIGIN,
  );
  const response = await fetch(upstream, {
    headers: {
      accept: request.headers.get('accept') ?? 'application/json',
      upgrade: request.headers.get('upgrade') ?? '',
      connection: request.headers.get('connection') ?? '',
    },
  });
  if (response.webSocket) return response;
  const headers = secureHeaders(new Headers(response.headers));
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (publicApiPaths.has(url.pathname)) {
      return proxyPublicApi(request, environment);
    }
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const response = await environment.ASSETS.fetch(request);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: secureHeaders(new Headers(response.headers)),
    });
  },
} satisfies ExportedHandler<Environment>;
