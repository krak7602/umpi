import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BROWSER_IMAGE_BYTES, browserCookieAllowed, browserPublicUrl, browserUrl, parseBrowserAssignment, parseBrowserReceipt, parseBrowserRequest, parseBrowserSite, requestedBrowserSite } from "../src/shared/browser.js";
function image(bytes: Uint8Array): object { return { operationId: "image", status: "done", image: { siteId: "fixture", url: "https://example.test/", mimeType: "image/png", data: Buffer.from(bytes).toString("base64") } }; }
test("typed browser enums reject JSON arrays before they become dispatched arguments", () => {
  const action = { kind: "press", siteId: "fixture", snapshotId: "view", ref: "e1", key: "Enter" };
  for (const key of [["Enter"], { toString: () => "Enter" }, 0, null]) assert.throws(() => parseBrowserRequest({ operationId: "press", action: { ...action, key } }));
  assert.equal(parseBrowserRequest({ operationId: "press", action }).action.kind, "press");
  assert.throws(() => parseBrowserReceipt({ operationId: "receipt", status: ["running"] }));
});
test("PNG limits use decoded bytes, including the shared-base64-length off-by-one boundary", () => {
  const bytes = Buffer.alloc(MAX_BROWSER_IMAGE_BYTES + 1); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(Buffer.from(bytes.subarray(0, MAX_BROWSER_IMAGE_BYTES)).toString("base64").length, bytes.toString("base64").length);
  assert.throws(() => parseBrowserReceipt(image(bytes)));
  const accepted = parseBrowserReceipt(image(bytes.subarray(0, MAX_BROWSER_IMAGE_BYTES)));
  assert.equal(Buffer.from(accepted.image!.data, "base64").byteLength, MAX_BROWSER_IMAGE_BYTES);
});
test("image receipts reject false PNG signatures and noncanonical unused base64 bits", () => {
  assert.throws(() => parseBrowserReceipt(image(Buffer.alloc(32))));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const receipt = image(bytes); assert.equal(parseBrowserReceipt(receipt).status, "done");
  const encoded = bytes.toString("base64"), alias = encoded.slice(0, -3) + "B==";
  assert.deepEqual(Buffer.from(alias, "base64"), bytes);
  assert.throws(() => parseBrowserReceipt({ operationId: "image", status: "done", image: { siteId: "fixture", url: "https://example.test/", mimeType: "image/png", data: alias } }));
});

test("public website eligibility rejects special/private destinations and keeps private-suffix tenants separate", () => {
  for (const url of ["http://example.com/", "https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://192.168.1.1/", "https://site.internal/", "https://x.home.arpa/", "https://x.in-addr.arpa/", "https://x.onion/", "https://example.com:8443/", "https://user:password@example.com/"]) assert.throws(() => browserPublicUrl(url));
  const site = requestedBrowserSite("https://shop.github.io/path"), parsed = parseBrowserSite(site);
  assert.equal(parsed.domain, "shop.github.io");
  assert.equal(browserUrl("https://cdn.shop.github.io/page", site.origins, false, site.domain), "https://cdn.shop.github.io/page");
  assert.throws(() => browserUrl("https://other.github.io/", site.origins, false, site.domain));
  assert.equal(browserCookieAllowed("session", ".shop.github.io", site), true);
  assert.equal(browserCookieAllowed("session", ".login.shop.github.io", site), true);
  for (const domain of [".github.io", ".other.github.io", ".shop.github.io.other.com", "..shop.github.io", "SHOP.github.io"]) assert.equal(browserCookieAllowed("session", domain, site), false);
  assert.throws(() => parseBrowserSite({ ...site, domain: "github.io" }));
});

test("transported domain policies retain navigation authorization and reject shadow cookie scopes", () => {
  const site = requestedBrowserSite("https://www.example.com/");
  const assignment = parseBrowserAssignment({ taskId: "domain-task", runId: "domain-run", deadlineAt: new Date(Date.now() + 60_000).toISOString(), sites: [{ site: { ...site, version: 1, policyDigest: "a".repeat(64) }, startUrl: "https://account.example.com/" }] });
  const transported = assignment.sites[0]!.site;
  assert.equal(browserUrl("https://cdn.example.com/page", transported.origins, false, transported.domain), "https://cdn.example.com/page");
  assert.throws(() => browserUrl("https://other.com/", transported.origins, false, transported.domain));
  assert.throws(() => parseBrowserSite({ ...site, cookieHosts: [".other.com"] }));
  assert.throws(() => parseBrowserSite({ ...site, resources: ["public"] }));
  assert.throws(() => parseBrowserSite({ ...site, origins: ["https://other.com"] }));
});
