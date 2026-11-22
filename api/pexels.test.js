import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import handler, { toPhotoPayload } from "./pexels.js";

const KEY = process.env.PEXELS_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (KEY === undefined) delete process.env.PEXELS_API_KEY;
  else process.env.PEXELS_API_KEY = KEY;
});

function fakeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
  };
  return res;
}

test("Pexels projection only returns bounded HTTPS provider URLs and text", () => {
  const result = toPhotoPayload({
    src: {
      medium: "http://images.pexels.com/medium.jpg",
      large: "https://images.pexels.com/large.jpg",
      large2x: `https://images.pexels.com/${"x".repeat(2049)}`,
    },
    url: "https://attacker.example/photo",
    photographer: "P".repeat(130),
    alt: "A".repeat(250),
  });

  assert.deepEqual(result.src, { large: "https://images.pexels.com/large.jpg" });
  assert.equal(result.link, "");
  assert.equal(result.photographer.length, 120);
  assert.equal(result.alt.length, 200);
});

test("Pexels projection drops a photo without an allowed large image URL", () => {
  for (const large of [
    "javascript:alert(1)",
    "https://images.pexels.com.evil.test/a.jpg",
    "//images.pexels.com/a.jpg",
  ]) {
    assert.equal(toPhotoPayload({ src: { large } }), null);
  }
});

test("Pexels API sends bounded upstream requests with an abort timeout", async () => {
  process.env.PEXELS_API_KEY = "test-key";
  let requestInit;
  globalThis.fetch = async (_url, init) => {
    requestInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ photos: [] }),
    };
  };

  const res = fakeRes();
  await handler({ method: "GET", query: { query: "Tarbes" } }, res);

  assert.ok(requestInit.signal instanceof AbortSignal);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["Cache-Control"], "public, max-age=600");
});

test("Pexels API rejects control characters before making an upstream request", async () => {
  process.env.PEXELS_API_KEY = "test-key";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("unexpected upstream request");
  };

  for (const query of ["Paris\u0000 France", "\tParis"]) {
    const res = fakeRes();
    await handler({ method: "GET", query: { query } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "invalid_query" });
    assert.equal(res.headers["Cache-Control"], "no-store");
  }
  assert.equal(called, false);
});
