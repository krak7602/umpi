import test from "node:test";
import assert from "node:assert/strict";
import { publicPage } from "../src/worker/public-pages.js";

const paths = ["/", "/privacy", "/terms"] as const;
const origin = "https://public-pages.invalid";

function response(path: string, init?: RequestInit): Response {
  const result = publicPage(new Request(`${origin}${path}`, init));
  assert.ok(result, `Expected a public response for ${path}`);
  return result;
}

test("public pages serve GET and bodyless HEAD with matching representation headers", async () => {
  for (const path of paths) {
    const get = response(path);
    const head = response(path, { method: "HEAD" });
    assert.equal(get.status, 200);
    assert.equal(head.status, get.status);
    assert.match(get.headers.get("content-type") ?? "", /^text\/html\s*;\s*charset=utf-8$/i);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal(head.body, null);
    assert.equal(await head.text(), "");
  }
});

test("only exact public pathnames and GET or HEAD are claimed", () => {
  const outside = [
    "/privacy/", "/terms/", "/Privacy", "/TERMS", "//privacy", "/privacy/child",
    "/privacy.json", "/terms-and-conditions", "/%70rivacy", "/privacy%2f",
    "/constructor", "/toString", "/__proto__", "/favicon.ico", "/robots.txt",
    "/oauth/callback", "/login",
  ];
  for (const path of outside) {
    for (const method of ["GET", "HEAD"]) {
      assert.equal(publicPage(new Request(`${origin}${path}`, { method })), undefined, `${method} ${path}`);
    }
  }
  for (const path of paths) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const request = new Request(`${origin}${path}`, { method, body: "private-request-body" });
      assert.equal(publicPage(request), undefined, `${method} ${path}`);
      assert.equal(request.bodyUsed, false);
    }
  }
});

test("private API requests fall through without a public authentication bypass", () => {
  const privatePaths = [
    "/api", "/api/chat", "/api/context", "/api/planning", "/api/schedule", "/api/mail", "/api/mail/items",
    "/api/companion", "/api/privacy", "/api/terms", "/privacy/api/chat", "/terms/api/context",
  ];
  for (const path of privatePaths) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const headers of [new Headers(), new Headers({ authorization: "Bearer irrelevant-test-credential" })]) {
        const request = new Request(`${origin}${path}?page=/privacy`, { method, headers });
        assert.equal(publicPage(request), undefined, `${method} ${path}`);
        assert.equal(request.bodyUsed, false);
      }
    }
  }
});

test("public representations do not reflect URL, credentials, cookies or request headers", async () => {
  const marker = "private-request-marker-<script>";
  for (const path of paths) {
    const baseline = response(path);
    const baselineText = await baseline.text();
    const request = new Request(`https://alternate-host.invalid${path}?context=${encodeURIComponent(marker)}#private-fragment`, {
      headers: {
        authorization: `Bearer ${marker}`,
        cookie: `context=${marker}`,
        "x-private-context": marker,
        "x-forwarded-host": "untrusted-host.invalid",
        origin: "https://untrusted-origin.invalid",
        accept: "application/json",
      },
    });
    const result = publicPage(request);
    assert.ok(result);
    assert.equal(await result.text(), baselineText);
    assert.deepEqual([...result.headers], [...baseline.headers]);
    const head = response(`${path}?context=${encodeURIComponent(marker)}`, { method: "HEAD" });
    assert.equal(await head.text(), "");
    assert.deepEqual([...head.headers], [...baseline.headers]);
  }
});

test("public responses prohibit active content, framing, referrers and storage", async () => {
  for (const path of paths) {
    for (const method of ["GET", "HEAD"]) {
      const result = response(path, { method });
      const csp = result.headers.get("content-security-policy") ?? "";
      for (const directive of ["default-src", "script-src", "connect-src", "object-src", "base-uri", "form-action", "frame-ancestors"]) {
        assert.match(csp, new RegExp(`(?:^|;\\s*)${directive}\\s+'none'(?:;|$)`));
      }
      assert.equal(result.headers.get("referrer-policy"), "no-referrer");
      assert.match(result.headers.get("cache-control") ?? "", /(?:^|,\s*)no-store(?:,|$)/);
      assert.equal(result.headers.get("x-content-type-options"), "nosniff");
      assert.equal(result.headers.has("set-cookie"), false);
      assert.equal(result.headers.has("access-control-allow-origin"), false);
      const html = await result.text();
      assert.doesNotMatch(html, /<(?:script|form|iframe|img|object|embed)\b/i);
      assert.doesNotMatch(html, /\s(?:src|on\w+)\s*=/i);
      assert.doesNotMatch(html, /(?:href\s*=\s*["']\s*(?:https?:|\/\/|javascript:)|@import\b|url\s*\()/i);
    }
  }
});

test("each request has independent consumable response state", async () => {
  for (const path of paths) {
    const first = response(path);
    const expected = await first.text();
    first.headers.set("set-cookie", "caller-only=value");
    const second = response(path);
    assert.equal(second.headers.has("set-cookie"), false);
    assert.equal(await second.text(), expected);
  }
});
