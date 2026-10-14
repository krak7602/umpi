import { planningDayBounds, shiftPlanningDay } from "../shared/daily-planning.js";

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

export interface CalendarCredentials { clientId: string; clientSecret: string; refreshToken: string }
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status: "confirmed" | "tentative";
  url?: string;
}
export interface CalendarSnapshot {
  day: string;
  timezone: string;
  checkedAt: string;
  coverage: "complete" | "partial" | "unavailable";
  events: CalendarEvent[];
  issues: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid calendar data");
  return value as Record<string, unknown>;
}
function secret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/\s/.test(value);
}
export function parseCalendarCredentials(value: unknown): CalendarCredentials {
  const data = object(value);
  if (!secret(data.clientId) || !secret(data.clientSecret) || !secret(data.refreshToken)) throw new Error("Invalid calendar credentials");
  return { clientId: data.clientId, clientSecret: data.clientSecret, refreshToken: data.refreshToken };
}

const API = "https://www.googleapis.com/calendar/v3";
// Bound fan-out and pagination independently; hitting any bound is never complete coverage.
const LIST_PAGES = 5;
const CALENDARS = 32;
const EVENT_PAGES = 4;
const PAGE_SIZE = 250;
const MAX_EVENTS = 2_000;
const READ_ROLES: Record<string, true> = { reader: true, writerWithoutPrivateAccess: true, writer: true, owner: true };

function page(value: unknown): { data: Record<string, unknown>; items: unknown[]; next?: string } {
  const data = object(value);
  if (data.items !== undefined && !Array.isArray(data.items)) throw new Error("Invalid calendar page");
  if (data.nextPageToken !== undefined && (typeof data.nextPageToken !== "string" || !data.nextPageToken || data.nextPageToken.length > 8192)) throw new Error("Invalid calendar page");
  return { data, items: data.items as unknown[] | undefined ?? [], next: data.nextPageToken as string | undefined };
}

async function identity(calendar: string, event: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([calendar, event])));
  return `calendar-${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function eventDate(value: unknown, allDay: boolean): string {
  if (typeof value !== "string") throw new Error("Invalid calendar date");
  if (allDay) return shiftPlanningDay(value, 0);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid calendar date");
  shiftPlanningDay(value.slice(0, 10), 0);
  return value;
}
async function calendarEvent(calendar: string, value: unknown): Promise<CalendarEvent | undefined> {
  const data = object(value);
  if (data.status === "cancelled") return undefined;
  if (data.attendees !== undefined && !Array.isArray(data.attendees)) throw new Error("Invalid calendar attendees");
  if ((data.attendees as unknown[] | undefined)?.some(value => {
    const attendee = object(value);
    return attendee.self === true && attendee.responseStatus === "declined";
  })) return undefined;
  if (typeof data.id !== "string" || !data.id || (data.status !== "confirmed" && data.status !== "tentative")) throw new Error("Invalid calendar event");
  const startData = object(data.start);
  const endData = object(data.end);
  const allDay = typeof startData.date === "string";
  const start = eventDate(allDay ? startData.date : startData.dateTime, allDay);
  const end = eventDate(allDay ? endData.date : endData.dateTime, allDay);
  if (allDay ? end <= start : Date.parse(end) <= Date.parse(start)) throw new Error("Invalid calendar interval");
  if (data.summary !== undefined && typeof data.summary !== "string") throw new Error("Invalid calendar title");
  const title = typeof data.summary === "string" && data.summary.trim() ? data.summary.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim() : "Untitled event";
  const result: CalendarEvent = { id: await identity(calendar, data.id), title, start, end, allDay, status: data.status };
  if (typeof data.htmlLink === "string") {
    const url = new URL(data.htmlLink);
    if (url.protocol === "https:" && !url.username && !url.password) result.url = url.href;
  }
  return result;
}

/** One refresh owner, one attempt, no retries. Issues never contain remote response text or identifiers. */
export async function readCalendarDay(
  credentials: string | undefined, day: string, timezone: string, now = Date.now(), fetcher: typeof fetch = fetch,
): Promise<CalendarSnapshot> {
  const snapshot: CalendarSnapshot = { day, timezone, checkedAt: new Date(now).toISOString(), coverage: "unavailable", events: [], issues: [] };
  const issue = (message: string) => { if (!snapshot.issues.includes(message)) snapshot.issues.push(message); };
  let bounds: { start: string; end: string };
  try { bounds = planningDayBounds(day, timezone); }
  catch { issue("Calendar day or timezone is invalid."); return snapshot; }
  let auth: CalendarCredentials;
  try { auth = parseCalendarCredentials(JSON.parse(credentials ?? "null")); }
  catch { issue("Calendar authorization is missing or invalid."); return snapshot; }
  const signal = AbortSignal.timeout(45_000);
  let access: string;
  try {
    const response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "manual", signal,
      body: new URLSearchParams({ client_id: auth.clientId, client_secret: auth.clientSecret, refresh_token: auth.refreshToken, grant_type: "refresh_token" }),
    });
    if (!response.ok) throw new Error();
    const token = object(await response.json());
    if (!secret(token.access_token)) throw new Error();
    access = token.access_token;
  } catch { issue("Calendar authorization could not be refreshed."); return snapshot; }
  const get = async (url: URL) => {
    const response = await fetcher(url, { method: "GET", redirect: "manual", signal, headers: { Authorization: `Bearer ${access}` } });
    if (!response.ok) throw new Error();
    return page(await response.json());
  };
  const calendars = new Map<string, string>();
  let listComplete = false;
  let next: string | undefined;
  try {
    for (let index = 0; index < LIST_PAGES; index++) {
      const url = new URL(`${API}/users/me/calendarList`);
      url.search = new URLSearchParams({ maxResults: String(PAGE_SIZE), showHidden: "true", showDeleted: "false", fields: "nextPageToken,items(id,primary,selected,hidden,deleted,accessRole)" }).toString();
      if (next) url.searchParams.set("pageToken", next);
      const result = await get(url);
      for (const value of result.items) {
        const calendar = object(value);
        if (calendar.deleted === true || !(calendar.primary === true || (calendar.selected === true && calendar.hidden !== true))) continue;
        if (typeof calendar.id !== "string" || !calendar.id || typeof calendar.accessRole !== "string") { issue("Some calendar metadata is unavailable."); continue; }
        if (calendars.size >= CALENDARS && !calendars.has(calendar.id)) { issue("Calendar selection exceeded the read limit."); continue; }
        calendars.set(calendar.id, calendar.accessRole);
      }
      next = result.next;
      if (!next) { listComplete = true; break; }
    }
    if (!listComplete) issue("Calendar list pagination exceeded the read limit.");
  } catch { issue("Calendar list could not be fully read."); }
  if (!calendars.size) { issue("No readable selected calendars were found."); return snapshot; }
  const events = new Map<string, CalendarEvent>();
  let readablePages = 0;
  for (const [id, role] of calendars) {
    if (!Object.hasOwn(READ_ROLES, role)) { issue("Some selected calendars expose no event details."); continue; }
    if (events.size >= MAX_EVENTS || signal.aborted) { issue("Calendar day exceeded the read limit."); break; }
    next = undefined;
    let complete = false;
    try {
      for (let index = 0; index < EVENT_PAGES; index++) {
        const url = new URL(`${API}/calendars/${encodeURIComponent(id)}/events`);
        url.search = new URLSearchParams({
          timeMin: bounds.start, timeMax: bounds.end, timeZone: timezone, singleEvents: "true", orderBy: "startTime",
          showDeleted: "false", maxResults: String(PAGE_SIZE), maxAttendees: "1",
          fields: "nextPageToken,accessRole,items(id,status,summary,start(date,dateTime),end(date,dateTime),htmlLink,visibility,attendees(self,responseStatus))",
        }).toString();
        if (next) url.searchParams.set("pageToken", next);
        const result = await get(url);
        const effectiveRole = typeof result.data.accessRole === "string" ? result.data.accessRole : role;
        if (!Object.hasOwn(READ_ROLES, effectiveRole)) { issue("Some selected calendars expose no event details."); break; }
        readablePages++;
        for (const value of result.items) {
          try {
            const data = object(value);
            const event = await calendarEvent(id, data);
            if (!event) continue;
            if ((effectiveRole === "reader" || effectiveRole === "writerWithoutPrivateAccess") && (data.visibility === "private" || data.summary === undefined)) {
              issue("Some event details are private or unavailable.");
              if (data.summary === undefined) event.title = "Busy (details unavailable)";
            }
            events.set(event.id, event);
            if (events.size >= MAX_EVENTS) { issue("Calendar day exceeded the read limit."); break; }
          } catch { issue("Some calendar events could not be read."); }
        }
        next = result.next;
        if (events.size >= MAX_EVENTS) break;
        if (!next) { complete = true; break; }
      }
      if (!complete && next) issue("Calendar event pagination exceeded the read limit.");
    } catch { issue("Some selected calendar events could not be fetched."); }
  }
  snapshot.events = [...events.values()].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  snapshot.coverage = readablePages === 0 ? "unavailable" : snapshot.issues.length ? "partial" : "complete";
  return snapshot;
}
