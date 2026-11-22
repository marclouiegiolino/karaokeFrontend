import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import worker from "../src/worker.ts";
import { ApiError, api } from "../src/lib/api.ts";

const PROD_BACKEND_ORIGIN = "https://karaoke-backend-production.marclouiegi-olino.workers.dev";

function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      result += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    result += ch;
  }
  return result.replace(/,\s*([}\]])/g, "$1");
}

function createEnv(backendOrigin: string, onAsset?: (request: Request) => Response) {
  return {
    BACKEND_API_ORIGIN: backendOrigin,
    ASSETS: {
      async fetch(request: Request): Promise<Response> {
        return onAsset ? onAsset(request) : new Response("asset-ok", { status: 200 });
      },
    },
  };
}

test("Wrangler production, local dev, and Next dev env configurations preserve single-origin setup", async () => {
  const root = process.cwd();
  const prodConfig = JSON.parse(stripJsonComments(await readFile(join(root, "wrangler.jsonc"), "utf8")));
  assert.equal(prodConfig.name, "karaoke-frontend");
  assert.equal(prodConfig.assets?.directory, "./out");
  assert.deepEqual(prodConfig.assets?.run_worker_first, ["/api/*"]);
  assert.equal(prodConfig.vars?.BACKEND_API_ORIGIN, PROD_BACKEND_ORIGIN);

  const devConfig = JSON.parse(stripJsonComments(await readFile(join(root, "wrangler.dev.jsonc"), "utf8")));
  assert.equal(devConfig.name, "karaoke-frontend-local");
  assert.equal(devConfig.assets?.directory, "./out");
  assert.deepEqual(devConfig.assets?.run_worker_first, ["/api/*"]);
  assert.equal(devConfig.vars?.BACKEND_API_ORIGIN, "http://localhost:8787");

  const exampleEnv = await readFile(join(root, ".env.development.local.example"), "utf8");
  assert.match(exampleEnv, /^NEXT_PUBLIC_API_BASE_URL=http:\/\/localhost:8787\/api$/m);
});

test("frontend Worker streams /api/* requests and forwards cookies, headers, query strings, and status codes", async () => {
  const originalFetch = globalThis.fetch;
  const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, init });
    if (url.endsWith("/api/auth/login")) {
      const headers = new Headers({
        "content-type": "application/json",
        "access-control-allow-origin": "https://karaoke-frontend.example.com",
      });
      headers.append("set-cookie", "__Host-karaoke_session=sess123; Path=/; HttpOnly; Secure; SameSite=None");
      headers.append("set-cookie", "karaoke_csrf=abc; Path=/; Secure; SameSite=None");
      return new Response(JSON.stringify({ user: { id: "u1", role: "ADMIN" } }), {
        status: 200,
        headers,
      });
    }
    if (url.includes("/api/auth/me")) {
      return new Response(JSON.stringify({ user: { id: "u1", role: "ADMIN" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": "__Host-karaoke_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None",
      },
    });
  }) as typeof fetch;

  try {
    const env = createEnv(PROD_BACKEND_ORIGIN);
    const bodyText = JSON.stringify({ login: "admin", password: "fixture-password" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(bodyText);
        controller.enqueue(bytes.subarray(0, 10));
        controller.enqueue(bytes.subarray(10));
        controller.close();
      },
    });

    const loginRequest = new Request("https://karaoke-frontend.example.com/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://karaoke-frontend.example.com",
        host: "karaoke-frontend.example.com",
        "cf-connecting-ip": "203.0.113.10",
        "cf-ray": "ray-123",
        "x-forwarded-for": "203.0.113.10",
        "x-custom-trace": "trace-42",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const loginResponse = await worker.fetch(loginRequest, env);
    assert.equal(loginResponse.status, 200);
    assert.equal(captured[0]?.url, `${PROD_BACKEND_ORIGIN}/api/auth/login`);
    assert.equal(captured[0]?.init?.redirect, "manual");
    assert.equal(captured[0]?.init?.body, loginRequest.body, "Worker must stream request body without buffering");

    const forwardedHeaders = new Headers(captured[0]?.init?.headers);
    assert.equal(forwardedHeaders.get("origin"), "https://karaoke-frontend.example.com");
    assert.equal(forwardedHeaders.get("content-type"), "application/json");
    assert.equal(forwardedHeaders.get("x-custom-trace"), "trace-42");
    for (const stripped of [
      "host",
      "cf-connecting-ip",
      "cf-ipcountry",
      "cf-ray",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
    ]) {
      assert.equal(forwardedHeaders.get(stripped), null, `${stripped} must be stripped`);
    }

    assert.deepEqual(loginResponse.headers.getSetCookie(), [
      "__Host-karaoke_session=sess123; Path=/; HttpOnly; Secure; SameSite=None",
      "karaoke_csrf=abc; Path=/; Secure; SameSite=None",
    ]);

    const meResponse = await worker.fetch(
      new Request("https://karaoke-frontend.example.com/api/auth/me?include=profile", {
        method: "GET",
        headers: {
          origin: "https://karaoke-frontend.example.com",
          cookie: "__Host-karaoke_session=sess123",
        },
      }),
      env,
    );
    assert.equal(meResponse.status, 200);
    assert.equal(captured[1]?.url, `${PROD_BACKEND_ORIGIN}/api/auth/me?include=profile`);
    assert.equal(captured[1]?.init?.body, undefined);
    assert.equal(new Headers(captured[1]?.init?.headers).get("cookie"), "__Host-karaoke_session=sess123");

    const logoutResponse = await worker.fetch(
      new Request("https://karaoke-frontend.example.com/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "https://karaoke-frontend.example.com",
          cookie: "__Host-karaoke_session=sess123",
        },
      }),
      env,
    );
    assert.equal(logoutResponse.status, 204);
    assert.deepEqual(logoutResponse.headers.getSetCookie(), [
      "__Host-karaoke_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("frontend Worker routes static pages to ASSETS and enforces body size, protocol, and error handling", async () => {
  const originalFetch = globalThis.fetch;
  let assetCalls = 0;
  let upstreamCalls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    upstreamCalls += 1;
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;

  try {
    const env = createEnv(PROD_BACKEND_ORIGIN, () => {
      assetCalls += 1;
      return new Response("<html></html>", { status: 200 });
    });

    for (const path of ["/", "/index.html", "/api-docs"]) {
      const res = await worker.fetch(new Request(`https://karaoke-frontend.example.com${path}`), env);
      assert.equal(res.status, 200);
    }
    assert.equal(assetCalls, 3);
    assert.equal(upstreamCalls, 0);

    const tooLarge = await worker.fetch(
      new Request("https://karaoke-frontend.example.com/api/songs", {
        method: "POST",
        headers: { "content-length": "65537", "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error.code, "BODY_TOO_LARGE");
    assert.equal(upstreamCalls, 0);

    for (const badOrigin of ["", "not-a-url", "http://example.com"]) {
      const res = await worker.fetch(
        new Request("https://karaoke-frontend.example.com/api/health"),
        createEnv(badOrigin),
      );
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, "API_NOT_CONFIGURED");
    }

    const unreachable = await worker.fetch(
      new Request("https://karaoke-frontend.example.com/api/health"),
      env,
    );
    assert.equal(unreachable.status, 502);
    assert.equal((await unreachable.json()).error.code, "BAD_GATEWAY");

    // Local development HTTP backend remains permitted for localhost and 127.0.0.1.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    for (const localOrigin of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
      const localRes = await worker.fetch(
        new Request("http://localhost:3000/api/health"),
        createEnv(localOrigin),
      );
      assert.equal(localRes.status, 200);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser API helper uses same-origin relative /api/* paths and surfaces backend errors", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    if (url.endsWith("/api/auth/login")) {
      return new Response(
        JSON.stringify({ error: { code: "ORIGIN_DENIED", message: "Origin is not allowed." } }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const health = await api<{ ok: boolean }>("/health");
    assert.deepEqual(health, { ok: true });
    assert.equal(requests[0]?.url, "/api/health");
    assert.equal(requests[0]?.init?.credentials, "include");

    await assert.rejects(
      () =>
        api("/auth/login", {
          method: "POST",
          body: JSON.stringify({ login: "admin", password: "wrong" }),
        }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 403 &&
        err.code === "ORIGIN_DENIED" &&
        err.message === "Origin is not allowed.",
    );
    assert.equal(requests[1]?.url, "/api/auth/login");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
