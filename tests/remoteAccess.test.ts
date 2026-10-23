/**
 * Remote access is the security boundary for the phone app. These tests pin the
 * behaviour that matters: off by default, impossible to enable without a token,
 * constant-time comparison, origin allow-listing, and desktop-only gating.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeWebSocket,
  createRemoteAccessGuard,
  isDesktopOnlyPath,
  isPublicPath,
  loadRemoteAccessConfig,
  normalizeOrigin,
  originAllowed,
  RemoteAccessConfigError,
  tokenMatches,
} from "../server_remoteAccess";

const TOKEN = "0123456789abcdef0123456789abcdef";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

test("remote access is disabled by default and binds to loopback", () => {
  const config = loadRemoteAccessConfig(env());
  assert.equal(config.enabled, false);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.token, "");
  assert.equal(config.allowDesktopTools, false);
});

test("enabling remote access without a strong token refuses to start", () => {
  assert.throws(() => loadRemoteAccessConfig(env({ SARA_REMOTE_ACCESS: "1" })), RemoteAccessConfigError);
  assert.throws(
    () => loadRemoteAccessConfig(env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: "short" })),
    RemoteAccessConfigError,
  );
});

test("enabled config binds 0.0.0.0 and always allows Capacitor origins", () => {
  const config = loadRemoteAccessConfig(
    env({
      SARA_REMOTE_ACCESS: "1",
      SARA_ACCESS_TOKEN: TOKEN,
      SARA_ALLOWED_ORIGINS: "https://sara.example.com/, https://www.example.com",
    }),
  );
  assert.equal(config.enabled, true);
  assert.equal(config.host, "0.0.0.0");
  assert.ok(config.allowedOrigins.includes("https://sara.example.com"));
  assert.ok(config.allowedOrigins.includes("https://www.example.com"));
  assert.ok(config.allowedOrigins.includes("https://localhost"));
  assert.ok(config.allowedOrigins.includes("capacitor://localhost"));
});

test("tokens are compared exactly and empty values never match", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, `${TOKEN}x`), false);
  assert.equal(tokenMatches(TOKEN, ""), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("", TOKEN), false);
});

test("origin rules: none allowed when unset, exact match otherwise", () => {
  const config = loadRemoteAccessConfig(env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN }));
  assert.equal(originAllowed(config, undefined), true);
  assert.equal(originAllowed(config, "https://sara.example.com"), false);
  assert.equal(originAllowed(config, "null"), false);

  const scoped = loadRemoteAccessConfig(
    env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN, SARA_ALLOWED_ORIGINS: "https://Sara.Example.com/" }),
  );
  assert.equal(originAllowed(scoped, "https://sara.example.com"), true);
  assert.equal(originAllowed(scoped, "https://evil.example.com"), false);
  assert.equal(normalizeOrigin(" https://A.example.com/ "), "https://a.example.com");
});

test("public paths stay open, desktop-only paths are identified", () => {
  assert.equal(isPublicPath("/api/health"), true);
  assert.equal(isPublicPath("/api/config"), false);
  assert.equal(isDesktopOnlyPath("/api/logs/startup.log"), true);
  assert.equal(isDesktopOnlyPath("/api/characters/import"), true);
  assert.equal(isDesktopOnlyPath("/api/memories"), false);
});

/** Minimal express-like request/response doubles. */
function fakeReq(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    method: "GET",
    path: "/api/config",
    url: "/api/config",
    headers: {},
    // Default: a phone tunnel. Local tests pass a loopback socket.
    socket: { remoteAddress: "203.0.113.9" },
    ...overrides,
  } as unknown as Parameters<ReturnType<typeof createRemoteAccessGuard>>[0];
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    locals: {} as Record<string, unknown>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as Parameters<ReturnType<typeof createRemoteAccessGuard>>[1] & typeof res;
}

test("guard passes everything through when remote access is off", () => {
  const guard = createRemoteAccessGuard(loadRemoteAccessConfig(env()));
  let called = false;
  guard(fakeReq(), fakeRes(), () => {
    called = true;
  });
  assert.equal(called, true);
});

test("guard rejects missing token, accepts a valid bearer token", () => {
  const config = loadRemoteAccessConfig(env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN }));
  const guard = createRemoteAccessGuard(config);

  const denied = fakeRes();
  let passed = false;
  guard(fakeReq(), denied as never, () => {
    passed = true;
  });
  assert.equal(passed, false);
  assert.equal((denied as unknown as { statusCode: number }).statusCode, 401);

  const allowed = fakeRes();
  guard(
    fakeReq({ headers: { authorization: `Bearer ${TOKEN}` } }),
    allowed as never,
    () => {
      passed = true;
    },
  );
  assert.equal(passed, true);
});

test("guard accepts the token as a query parameter (asset and WebSocket style)", () => {
  const config = loadRemoteAccessConfig(env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN }));
  const guard = createRemoteAccessGuard(config);
  let passed = false;
  guard(fakeReq({ url: `/api/memories?access_token=${TOKEN}` }), fakeRes() as never, () => {
    passed = true;
  });
  assert.equal(passed, true);
});

test("guard leaves the SPA shell public but protects character files", () => {
  const config = loadRemoteAccessConfig(env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN }));
  const guard = createRemoteAccessGuard(config);

  let shellPassed = false;
  guard(fakeReq({ path: "/", url: "/" }), fakeRes() as never, () => {
    shellPassed = true;
  });
  assert.equal(shellPassed, true);

  let assetPassed = false;
  guard(fakeReq({ path: "/assets/index.js", url: "/assets/index.js" }), fakeRes() as never, () => {
    assetPassed = true;
  });
  assert.equal(assetPassed, true);

  const charRes = fakeRes();
  let charPassed = false;
  guard(fakeReq({ path: "/user-characters/x/model.pmx", url: "/user-characters/x/model.pmx" }), charRes as never, () => {
    charPassed = true;
  });
  assert.equal(charPassed, false);
  assert.equal((charRes as unknown as { statusCode: number }).statusCode, 401);
});

test("guard blocks PC-only endpoints for remote clients unless explicitly enabled", () => {
  const locked = createRemoteAccessGuard(
    loadRemoteAccessConfig(env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN })),
  );
  const res = fakeRes();
  let passed = false;
  locked(
    fakeReq({ path: "/api/logs/startup.log", url: "/api/logs/startup.log", headers: { authorization: `Bearer ${TOKEN}` } }),
    res as never,
    () => {
      passed = true;
    },
  );
  assert.equal(passed, false);
  assert.equal((res as unknown as { statusCode: number }).statusCode, 403);
  assert.equal((res as unknown as { body: { code: string } }).body.code, "SARA_DESKTOP_ONLY");

  const permissive = createRemoteAccessGuard(
    loadRemoteAccessConfig(
      env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN, SARA_REMOTE_ALLOW_DESKTOP: "1" }),
    ),
  );
  permissive(
    fakeReq({ path: "/api/logs/startup.log", url: "/api/logs/startup.log", headers: { "x-sara-token": TOKEN } }),
    fakeRes() as never,
    () => {
      passed = true;
    },
  );
  assert.equal(passed, true);
});

test("guard answers CORS preflight and rejects unknown origins", () => {
  const config = loadRemoteAccessConfig(
    env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN, SARA_ALLOWED_ORIGINS: "https://sara.example.com" }),
  );
  const guard = createRemoteAccessGuard(config);

  const preflight = fakeRes();
  guard(
    fakeReq({ method: "OPTIONS", headers: { origin: "https://sara.example.com" } }),
    preflight as never,
    () => assert.fail("preflight must not reach the route"),
  );
  assert.equal((preflight as unknown as { statusCode: number }).statusCode, 204);
  const headers = (preflight as unknown as { headers: Record<string, string> }).headers;
  assert.equal(headers["Access-Control-Allow-Origin"], "https://sara.example.com");
  assert.match(headers["Access-Control-Allow-Headers"], /Authorization/);

  const rejected = fakeRes();
  guard(fakeReq({ headers: { origin: "https://evil.example.com" } }), rejected as never, () => assert.fail("bad origin passed"));
  assert.equal((rejected as unknown as { statusCode: number }).statusCode, 403);
});

test("websocket authorization mirrors the HTTP rules", () => {
  const off = loadRemoteAccessConfig(env());
  assert.equal(
    authorizeWebSocket(off, { headers: { host: "127.0.0.1:3000" }, socket: { remoteAddress: "127.0.0.1" } } as never).ok,
    true,
  );
  assert.equal(authorizeWebSocket(off, { headers: { host: "sara.example.com" } } as never).ok, false);

  const on = loadRemoteAccessConfig(
    env({ SARA_REMOTE_ACCESS: "1", SARA_ACCESS_TOKEN: TOKEN, SARA_ALLOWED_ORIGINS: "https://sara.example.com" }),
  );
  const noToken = authorizeWebSocket(on, {
    headers: { host: "sara.example.com", origin: "https://sara.example.com" },
    url: "/live",
  } as never);
  assert.equal(noToken.ok, false);

  const withToken = authorizeWebSocket(on, {
    headers: { host: "sara.example.com", origin: "https://sara.example.com" },
    url: `/live?access_token=${TOKEN}`,
  } as never);
  assert.equal(withToken.ok, true);
  assert.equal(withToken.ok && withToken.remote, true);

  const stranger = authorizeWebSocket(on, {
    headers: { host: "sara.example.com", origin: "https://evil.example.com" },
    url: `/live?access_token=${TOKEN}`,
  } as never);
  assert.equal(stranger.ok, false);

  // Local windows keep working without a token even in remote mode.
  const local = authorizeWebSocket(on, {
    headers: { host: "127.0.0.1:3000", origin: "http://localhost:3000" },
    url: "/live",
    socket: { remoteAddress: "127.0.0.1" },
  } as never);
  assert.equal(local.ok, true);
  assert.equal(local.ok && local.remote, false);
});
