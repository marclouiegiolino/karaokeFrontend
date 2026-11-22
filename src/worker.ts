interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BACKEND_API?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  BACKEND_API_ORIGIN: string;
}

const MAX_API_BODY_BYTES = 65536;

const forbiddenForwardHeaders = [
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

async function proxyApi(request: Request, env: Env): Promise<Response> {
  if (!env.BACKEND_API_ORIGIN) {
    return Response.json(
      { error: { code: "API_NOT_CONFIGURED", message: "Backend API is not configured." } },
      { status: 503 },
    );
  }

  const incoming = new URL(request.url);
  let backendOrigin: URL;
  try {
    backendOrigin = new URL(env.BACKEND_API_ORIGIN);
  } catch {
    return Response.json(
      { error: { code: "API_NOT_CONFIGURED", message: "Backend API URL is invalid." } },
      { status: 503 },
    );
  }
  if (
    backendOrigin.protocol !== "https:" &&
    backendOrigin.hostname !== "localhost" &&
    backendOrigin.hostname !== "127.0.0.1"
  ) {
    return Response.json(
      { error: { code: "API_NOT_CONFIGURED", message: "Backend API must use HTTPS." } },
      { status: 503 },
    );
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_API_BODY_BYTES) {
    return Response.json(
      { error: { code: "BODY_TOO_LARGE", message: "JSON body exceeds 64 KB" } },
      { status: 413 },
    );
  }

  const target = new URL(`${incoming.pathname}${incoming.search}`, backendOrigin);
  const headers = new Headers(request.headers);
  for (const name of forbiddenForwardHeaders) headers.delete(name);

  const method = request.method;
  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && request.body) {
    init.body = request.body;
  }

  let upstream: Response;
  try {
    upstream = env.BACKEND_API
      ? await env.BACKEND_API.fetch(target.href, init)
      : await fetch(target.href, init);
  } catch {
    return Response.json(
      { error: { code: "BAD_GATEWAY", message: "Unable to reach the backend API." } },
      { status: 502 },
    );
  }
  const responseHeaders = new Headers(upstream.headers);
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (setCookies.length) {
    responseHeaders.delete("set-cookie");
    for (const cookie of setCookies) responseHeaders.append("set-cookie", cookie);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return proxyApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

export default worker;
