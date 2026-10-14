const styles = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.6; }
body { margin: 0; background: Canvas; color: CanvasText; }
header, main, footer { max-width: 48rem; margin: auto; padding: 1.5rem; }
header { border-bottom: 1px solid GrayText; }
nav { display: flex; flex-wrap: wrap; gap: 1rem; }
a { color: LinkText; text-underline-offset: .2em; }
a:focus-visible { outline: 2px solid Highlight; outline-offset: 4px; }
h1, h2 { line-height: 1.25; }
h1 { margin-top: 0; }
h2 { margin-top: 2rem; }
li + li { margin-top: .5rem; }
footer { border-top: 1px solid GrayText; font-size: .9rem; }
.skip { position: absolute; left: 1rem; top: -5rem; padding: .5rem; background: Canvas; }
.skip:focus { top: .5rem; }
`;

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Umpi</title>
<style>${styles}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header><nav aria-label="Main navigation"><a href="/">Umpi</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></header>
<main id="main">${content}</main>
<footer>Umpi · Owner-operated personal assistant</footer>
</body>
</html>`;
}

const pages: Record<"/" | "/privacy" | "/terms", string> = {
  "/": page("Personal assistant", `
<h1>Umpi</h1>
<p>Umpi is an owner-operated personal assistant for private, personal use. It brings together chat, selected context and planning, with Obsidian notes and a native companion app.</p>
<h2>Personal assistant integrations</h2>
<p>Umpi can use separately authorized, read-only Google Calendar and Gmail grants. Calendar data helps plan around availability and events. Bounded Gmail data supports owner-enabled follow-through for recent messages. Each operator supplies and controls their own OAuth registration and credentials.</p>
<h2>How Umpi is used</h2>
<ul>
<li>The owner chats with the assistant and chooses the context available to it.</li>
<li>Planning can use selected calendar information and selected Obsidian notes, and apply approved note updates through Obsidian Sync. Optional mail follow-through can inspect bounded recent Gmail threads and notify the owner about selected follow-up.</li>
<li>Telegram and the native companion provide assistant interactions and delivery when configured.</li>
</ul>
<p>This site provides app information, not public registration or a Google sign-in flow. Configuration and authorization are controlled by the owner.</p>
<p>Read the <a href="/privacy">privacy information</a> and <a href="/terms">terms of use</a> for data handling and operating limits. For support, contact the owner using the support email shown on the Google consent screen.</p>
`),
  "/privacy": page("Privacy", `
<h1>Privacy</h1>
<p>Umpi is an owner-operated personal assistant, not a public multi-user service. The owner chooses which accounts, context and delivery channels to configure.</p>
<h2>Information used</h2>
<ul>
<li>Chat messages, selected context and notes, planning inputs and outputs, and operational records needed for assistant jobs, approvals, reminders and delivery.</li>
<li>Selected Google Calendar metadata and event information, including titles, start and end times, all-day and event status, event links when available, and the owner's attendance status used to exclude declined events.</li>
<li>For optional mail follow-through: bounded Gmail sender, subject, timestamps, labels, links and message excerpts after an owner-selected cutoff, plus generated summaries, reasons and owner-action status.</li>
<li>Configured account credentials and delivery settings needed to access authorized providers and channels.</li>
</ul>
<p>Umpi uses separate read-only Google grants. The Calendar grant is limited to calendar-list and calendar-event access. The Gmail grant is limited to <code>gmail.readonly</code>. Umpi does not authorize Calendar or Gmail mutation, import credentials from other clients, download Gmail attachments, send mail, save Gmail drafts, mark messages read, archive, delete or change labels.</p>
<h2>Storage and processing</h2>
<p>Assistant state and operational records are stored in private Cloudflare SQLite storage. Selected Gmail thread excerpts are stored there while they remain relevant for triage or owner action; ignored, resolved and handled message excerpts are cleared, while bounded metadata, summaries and action history can remain. Selected vault snapshots and related planning data can be stored in private Cloudflare R2 storage. Approved Obsidian note updates propagate through Obsidian Sync to the owner's connected vault devices.</p>
<p>Selected context, planning inputs and bounded mail candidates are sent to the owner-selected model provider for inference. Responses and notifications are delivered through Telegram or the native companion app as configured; those delivery services receive the content and routing information needed for delivery. Google, Cloudflare, Obsidian, model providers and delivery providers have their own terms and data practices. Umpi does not make guarantees about external providers' retention, training or security practices.</p>
<p>Operators must use Google user data consistently with the Google API Services User Data Policy, including its Limited Use requirements. Umpi uses that data only to provide the owner-facing calendar, planning and mail follow-through features described here.</p>
<h2>Retention and controls</h2>
<p>Stored operational records and notes are retained until explicitly removed. Revoking Google access stops future authorized Calendar or Gmail access; it does not erase information already stored in assistant records, model-provider systems, Telegram messages, notes, synced devices or other provider systems.</p>
<p>The owner can pause mail follow-through, revoke Google access through Google account controls, manage other provider authorizations through their account controls, and disable configured integrations. Stored assistant data and notes must be removed separately using the relevant owner and provider controls. Obsidian Sync and offline devices can affect when note changes or removals propagate.</p>
<h2>Use and contact</h2>
<p>Umpi does not sell personal data, use it for advertising, or use it for app-side training of general-purpose models. Data is used to operate the owner's personal assistant and configured integrations.</p>
<p>For privacy questions or help with stored data, contact the owner using the support email shown on the Google consent screen. There is no public account creation on this site.</p>
`),
  "/terms": page("Terms of use", `
<h1>Terms of use</h1>
<p>Umpi is configured and authorized by its owner for personal use. This informational site does not offer public accounts, public sign-up or access to the owner's assistant.</p>
<h2>Authorization and approvals</h2>
<p>The owner is responsible for selecting accounts, providers, context and delivery channels they are authorized to use. Connecting a provider does not replace separate approvals required for assistant actions or note updates. Umpi's Google Calendar and Gmail grants are read-only.</p>
<h2>Planning, mail and notes</h2>
<p>Assistant output depends on the supplied context, available sources and the time at which they were checked. Calendar or Gmail coverage can be partial or unavailable; plans and mail triage are not guarantees of current availability, importance, completed work or required replies. The owner should review proposed changes, reply drafts and time-sensitive information while they are still useful.</p>
<p>Obsidian updates follow normal Sync behavior. Offline devices, propagation delays and concurrent edits can delay updates or produce conflicts. A note update does not guarantee that every connected device immediately has the same content.</p>
<h2>Delivery and availability</h2>
<p>Reminders, background work and notifications depend on configured services, connectivity and device operating-system permissions and background limits. Delivery at an exact time or to every device is not guaranteed. Disabled scheduling remains disabled until the owner enables it.</p>
<h2>Usage and subscriptions</h2>
<p>Use remains subject to actual account permissions, provider rate limits, quotas, usage charges and subscription limits, including those of model, hosting, sync and delivery services. Configuring Umpi does not provide additional provider entitlements or remove their limits. The owner manages those accounts and subscriptions.</p>
<p>For questions, contact the owner using the support email shown on the Google consent screen. See <a href="/privacy">Privacy</a> for information about data handling and revocation.</p>
`),
};

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Public informational pages only; all other requests stay with the authorized router. */
export function publicPage(request: Request): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return;
  const path = new URL(request.url).pathname;
  if (path !== "/" && path !== "/privacy" && path !== "/terms") return;
  return new Response(request.method === "HEAD" ? null : pages[path], { headers });
}
