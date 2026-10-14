import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { calendarCredentialStatus, loginCalendar } from "../src/cli/calendar.js";
import { CALENDAR_SCOPES, readCalendarDay } from "../src/worker/calendar.js";

const credentials = { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh" };
const credentialJson = JSON.stringify(credentials);
const day = "2026-03-08";
const now = Date.parse("2026-03-08T12:00:00Z");
const primary = { id: "synthetic-primary", primary: true, accessRole: "owner" };
const event = { id: "synthetic-series_20260308T140000Z", summary: "Synthetic appointment", status: "confirmed", start: { dateTime: "2026-03-08T10:00:00-04:00" }, end: { dateTime: "2026-03-08T11:00:00-04:00" } };

function calendarTransport(handler: (url: URL, init: RequestInit) => unknown): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.protocol, "https:");
    if (url.hostname === "oauth2.googleapis.com") {
      assert.equal(init.method, "POST");
      assert.equal(url.search, "");
      const body = init.body as URLSearchParams;
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), credentials.refreshToken);
      assert.equal(body.get("client_secret"), credentials.clientSecret);
      return Response.json({ access_token: "synthetic-access" });
    }
    assert.equal(url.hostname, "www.googleapis.com");
    assert.equal(init.method, "GET");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-access");
    const value = handler(url, init);
    return value instanceof Response ? value : Response.json(value);
  };
}

test("missing and malformed credentials never become an empty complete schedule", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error("must not fetch"); };
  for (const auth of [undefined, "{}", "not JSON", JSON.stringify({ ...credentials, refreshToken: "" })]) {
    const result = await readCalendarDay(auth, day, "UTC", now, transport);
    assert.equal(result.coverage, "unavailable");
    assert.deepEqual(result.events, []);
    assert.equal(result.checkedAt, new Date(now).toISOString());
  }
  assert.equal(calls, 0);
});

test("invalid dates and zones fail closed before network calls", async () => {
  const transport: typeof fetch = async () => { throw new Error("must not fetch"); };
  for (const [date, zone] of [["2026-02-30", "UTC"], [day, "Not/AZone"]]) {
    const result = await readCalendarDay(credentialJson, date!, zone!, now, transport);
    assert.equal(result.coverage, "unavailable");
  }
});

test("refresh failures are unavailable, single attempt, and redact provider errors", async () => {
  let calls = 0;
  const result = await readCalendarDay(credentialJson, day, "UTC", now, async () => {
    calls++;
    return new Response("synthetic-secret provider account details", { status: 401 });
  });
  assert.equal(calls, 1);
  assert.equal(result.coverage, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /synthetic|provider account/);
});

test("calendar selection and projected event queries use DST-aware bounds and no write scope", async () => {
  for (const [date, expectedStart, expectedEnd] of [
    ["2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
  ]) {
    const queried: string[] = [];
    const result = await readCalendarDay(credentialJson, date!, "America/New_York", now, calendarTransport(url => {
      if (url.pathname.endsWith("calendarList")) return { items: [
        { ...primary, hidden: true },
        { id: "synthetic-selected", selected: true, accessRole: "reader" },
        { id: "synthetic-hidden", selected: true, hidden: true, accessRole: "reader" },
        { id: "synthetic-unselected", accessRole: "reader" },
      ] };
      queried.push(url.pathname);
      assert.equal(Date.parse(url.searchParams.get("timeMin")!), Date.parse(expectedStart!));
      assert.equal(Date.parse(url.searchParams.get("timeMax")!), Date.parse(expectedEnd!));
      assert.equal(url.searchParams.get("timeZone"), "America/New_York");
      assert.equal(url.searchParams.get("singleEvents"), "true");
      assert.equal(url.searchParams.get("orderBy"), "startTime");
      assert.equal(url.searchParams.get("maxAttendees"), "1");
      assert.doesNotMatch(url.searchParams.get("fields")!, /description|email|displayName|organizer|location/);
      assert.match(url.searchParams.get("fields")!, /attendees\(self,responseStatus\)/);
      return { items: [] };
    }));
    assert.equal(result.coverage, "complete");
    assert.deepEqual(queried, ["/calendar/v3/calendars/synthetic-primary/events", "/calendar/v3/calendars/synthetic-selected/events"]);
  }
  assert.equal(CALENDAR_SCOPES.length, 2);
  assert.ok(CALENDAR_SCOPES.every(scope => scope.endsWith(".readonly")));
});

test("stable identity survives title and time changes; instances remain distinct; exclusions and all-day end are preserved", async () => {
  async function snapshot(summary: string, start = event.start) {
    return readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => url.pathname.endsWith("calendarList") ? { items: [primary] } : { items: [
      { ...event, summary, start },
      { ...event, id: "synthetic-second-instance", summary, status: "tentative" },
      { id: "synthetic-day", summary: "Synthetic all-day", status: "confirmed", start: { date: day }, end: { date: "2026-03-10" } },
      { id: "synthetic-cancelled", status: "cancelled" },
      { ...event, id: "synthetic-declined", attendees: [{ self: true, responseStatus: "declined" }] },
      { ...event, id: "synthetic-other-declined", attendees: [{ self: false, responseStatus: "declined" }] },
    ] }));
  }
  const first = await snapshot("Original synthetic title");
  const changed = await snapshot("Reworded synthetic title", { dateTime: "2026-03-08T10:30:00-04:00" });
  assert.equal(first.coverage, "complete");
  assert.equal(first.events.length, 4);
  assert.deepEqual(first.events.map(item => item.id).sort(), changed.events.map(item => item.id).sort());
  assert.equal(new Set(first.events.map(item => item.id)).size, 4);
  assert.ok(first.events.every(item => /^calendar-[a-f0-9]{64}$/.test(item.id)));
  assert.equal(first.events.find(item => item.allDay)?.end, "2026-03-10");
  assert.equal(first.events.filter(item => item.status === "tentative").length, 1);
});

test("calendar and event pagination includes empty intermediate pages and deduplicates identities", async () => {
  const pages: string[] = [];
  const result = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => {
    const token = url.searchParams.get("pageToken");
    if (url.pathname.endsWith("calendarList")) return token ? { items: [primary] } : { items: [], nextPageToken: "synthetic-list-page" };
    pages.push(token ?? "first");
    if (!token) return { items: [event], nextPageToken: "synthetic-empty-page" };
    if (token === "synthetic-empty-page") return { items: [], nextPageToken: "synthetic-last-page" };
    return { items: [event, { ...event, id: "synthetic-next" }] };
  }));
  assert.equal(result.coverage, "complete");
  assert.equal(result.events.length, 2);
  assert.deepEqual(pages, ["first", "synthetic-empty-page", "synthetic-last-page"]);
});

test("pagination caps retain useful events but cannot claim completeness", async () => {
  let lists = 0;
  let events = 0;
  const result = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => {
    if (url.pathname.endsWith("calendarList")) { lists++; return { items: [primary], nextPageToken: "synthetic-more-calendars" }; }
    events++;
    return { items: [event], nextPageToken: "synthetic-more-events" };
  }));
  assert.equal(lists, 5);
  assert.equal(events, 4);
  assert.equal(result.coverage, "partial");
  assert.equal(result.events.length, 1);
  assert.ok(result.issues.some(issue => /list pagination/.test(issue)));
  assert.ok(result.issues.some(issue => /event pagination/.test(issue)));
});

test("free-busy-only and inaccessible calendars are not false complete empty schedules", async () => {
  for (const role of ["freeBusyReader", "none"]) {
    const result = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => {
      assert.ok(url.pathname.endsWith("calendarList"));
      return { items: [{ ...primary, accessRole: role }] };
    }));
    assert.equal(result.coverage, "unavailable");
    assert.ok(result.issues.length);
  }
  const result = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => {
    if (url.pathname.endsWith("calendarList")) return { items: [primary, { id: "synthetic-inaccessible", selected: true, accessRole: "reader" }] };
    if (url.pathname.includes("synthetic-inaccessible")) return new Response("synthetic-sensitive-provider-error", { status: 403 });
    return { items: [event] };
  }));
  assert.equal(result.coverage, "partial");
  assert.equal(result.events.length, 1);
  assert.doesNotMatch(result.issues.join(" "), /synthetic/);
});

test("selection and total event limits bound fan-out without claiming complete coverage", async () => {
  let requests = 0;
  const selected = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => {
    if (url.pathname.endsWith("calendarList")) return { items: Array.from({ length: 40 }, (_, index) => ({ id: `synthetic-calendar-${index}`, selected: true, accessRole: "owner" })) };
    requests++;
    return { items: [] };
  }));
  assert.equal(requests, 32);
  assert.equal(selected.coverage, "partial");

  requests = 0;
  const capped = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => {
    if (url.pathname.endsWith("calendarList")) return { items: Array.from({ length: 12 }, (_, index) => ({ id: `synthetic-calendar-${index}`, selected: true, accessRole: "owner" })) };
    requests++;
    return { items: Array.from({ length: 250 }, (_, index) => ({ ...event, id: `synthetic-event-${index}` })) };
  }));
  assert.equal(requests, 8);
  assert.equal(capped.events.length, 2_000);
  assert.equal(capped.coverage, "partial");
});

test("a later calendar list failure retains already discovered events with partial coverage", async () => {
  const result = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => {
    if (url.pathname.endsWith("calendarList")) {
      if (url.searchParams.has("pageToken")) throw new Error("synthetic-private-provider-error");
      return { items: [primary], nextPageToken: "synthetic-next" };
    }
    return { items: [event] };
  }));
  assert.equal(result.coverage, "partial");
  assert.equal(result.events.length, 1);
  assert.doesNotMatch(result.issues.join(" "), /synthetic/);
});

test("private details, malformed events and downgraded access all report missing coverage", async () => {
  const result = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => url.pathname.endsWith("calendarList") ? { items: [primary] } : {
    accessRole: "reader", items: [{ ...event, summary: undefined, visibility: "private" }, { ...event, id: "synthetic-bad", start: { dateTime: "2026-02-30T10:00:00Z" } }],
  }));
  assert.equal(result.coverage, "partial");
  assert.equal(result.events.length, 1);
  assert.ok(result.issues.some(issue => /private/.test(issue)));
  const downgraded = await readCalendarDay(credentialJson, day, "UTC", now, calendarTransport(url => url.pathname.endsWith("calendarList") ? { items: [primary] } : { accessRole: "freeBusyReader", items: [] }));
  assert.equal(downgraded.coverage, "unavailable");
});

async function loginFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "umpi-calendar-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientConfig = join(root, "client.json");
  const output = join(root, "credentials.json");
  await writeFile(clientConfig, JSON.stringify({ installed: { client_id: credentials.clientId, client_secret: credentials.clientSecret, token_uri: "https://untrusted.invalid/ignored" } }), { mode: 0o600 });
  return { root, clientConfig, output };
}

test("installed OAuth uses real loopback state and PKCE; only the private refresh credential persists", async t => {
  const fixture = await loginFixture(t);
  let authorization: URL | undefined;
  let exchanges = 0;
  await loginCalendar({ clientConfig: fixture.clientConfig, credentials: fixture.output,
    authorize: async local => {
      assert.equal(new URL(local).hostname, "127.0.0.1");
      const redirect = await fetch(local, { redirect: "manual" });
      assert.equal(redirect.status, 302);
      authorization = new URL(redirect.headers.get("location")!);
      assert.equal(authorization.origin, "https://accounts.google.com");
      assert.equal(authorization.searchParams.get("scope"), CALENDAR_SCOPES.join(" "));
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorization.searchParams.get("access_type"), "offline");
      assert.equal(authorization.searchParams.get("include_granted_scopes"), "false");
      assert.doesNotMatch(authorization.href, /synthetic-secret|synthetic-refresh|login_hint/);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: "wrong", code: "synthetic-code" }).toString();
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("state", "é".repeat(43));
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      assert.equal((await fetch(callback)).status, 200);
    },
    fetcher: async (input, init) => {
      exchanges++;
      assert.equal(String(input), "https://oauth2.googleapis.com/token");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "synthetic-code");
      assert.equal(body.get("client_secret"), credentials.clientSecret);
      const verifier = body.get("code_verifier")!;
      assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), authorization?.searchParams.get("code_challenge"));
      return Response.json({ access_token: "synthetic-access-not-persisted", refresh_token: credentials.refreshToken, scope: CALENDAR_SCOPES.join(" ") });
    },
  });
  assert.equal(exchanges, 1);
  assert.deepEqual(JSON.parse(await readFile(fixture.output, "utf8")), credentials);
  assert.equal((await stat(fixture.output)).mode & 0o777, 0o600);
  assert.deepEqual(calendarCredentialStatus(fixture.output), { configured: true });
  await assert.rejects(loginCalendar({ clientConfig: fixture.clientConfig, credentials: fixture.output, authorize: () => assert.fail("existing output must stop before consent") }), /new credential path/);
});

test("OAuth refuses incomplete or broader grants, removes failed output, and hides provider details", async t => {
  for (const token of [
    { scope: CALENDAR_SCOPES[0], refresh_token: credentials.refreshToken },
    { scope: `${CALENDAR_SCOPES.join(" ")} https://www.googleapis.com/auth/calendar`, refresh_token: credentials.refreshToken },
    { scope: CALENDAR_SCOPES.join(" ") },
  ]) {
    const fixture = await loginFixture(t);
    await assert.rejects(loginCalendar({ clientConfig: fixture.clientConfig, credentials: fixture.output,
      authorize: async local => {
        const redirect = await fetch(local, { redirect: "manual" });
        const authorization = new URL(redirect.headers.get("location")!);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "synthetic-code" }).toString();
        await fetch(callback);
      },
      fetcher: async () => Response.json(token),
    }), error => error instanceof Error && /no credential was stored/.test(error.message) && !/synthetic/.test(error.message));
    assert.deepEqual(calendarCredentialStatus(fixture.output), { configured: false });
  }
});

test("private status and OAuth reject unsafe files and never import repository state", async t => {
  const fixture = await loginFixture(t);
  assert.deepEqual(calendarCredentialStatus(fixture.output), { configured: false });
  await writeFile(fixture.output, credentialJson, { mode: 0o600 });
  await chmod(fixture.output, 0o644);
  assert.throws(() => calendarCredentialStatus(fixture.output), /file safety/);
  await chmod(fixture.output, 0o600);
  const link = join(fixture.root, "linked.json");
  await symlink(fixture.output, link);
  assert.throws(() => calendarCredentialStatus(link), /file safety/);
  assert.throws(() => calendarCredentialStatus(join(process.cwd(), "package.json")), /file safety/);
  await chmod(fixture.clientConfig, 0o644);
  await assert.rejects(loginCalendar({ clientConfig: fixture.clientConfig, credentials: join(fixture.root, "new.json"), authorize: () => assert.fail("unsafe input must stop before consent") }), /protected installed-client/);
});

test("cancelled login closes callback and removes the reserved credential file", async t => {
  const fixture = await loginFixture(t);
  const cancellation = new AbortController();
  let localUrl = "";
  await assert.rejects(loginCalendar({ clientConfig: fixture.clientConfig, credentials: fixture.output, signal: cancellation.signal,
    authorize: local => { localUrl = local; cancellation.abort(); },
    fetcher: async () => assert.fail("cancelled login must not exchange tokens"),
  }), /cancelled/);
  assert.deepEqual(calendarCredentialStatus(fixture.output), { configured: false });
  await assert.rejects(fetch(localUrl));
});
