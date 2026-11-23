import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { StateError, type Store } from "./store.js";
import { assistantTools, ASSISTANT_INSTRUCTIONS, RESPONSE_STYLE_INSTRUCTIONS } from "./tools.js";
import { coreContextSection, coreContextTools } from "./core-context.js";
import { guardProvenance, PROVENANCE_INSTRUCTIONS, type ProvenanceCounts } from "./provenance.js";
import type { CompanionStore } from "./companion-store.js";
import { companionTools, COMPANION_INSTRUCTIONS } from "./companion-tools.js";
import type { ProactiveStore } from "./proactive-store.js";
import { proactiveTools, PROACTIVE_INSTRUCTIONS } from "./proactive-tools.js";
import { backgroundTools, guardBackgroundTools } from "./proactive-runtime.js";
import type { PlanningRuntime } from "./planning-runtime.js";
import { planningTools, guardPlanningReviewTools, PLANNING_INSTRUCTIONS } from "./planning-tools.js";
import type { MailStore } from "./mail-store.js";
import type { MailRuntime } from "./mail-runtime.js";
import { mailTools, guardMailReviewTools, MAIL_INSTRUCTIONS } from "./mail-tools.js";
import { DECISION_INSTRUCTIONS, decisionTools, type Decisions } from "./decisions.js";
import type { DreamStore } from "./dream-store.js";
import type { HistoryIndex } from "./history-index.js";
import { DREAM_INSTRUCTIONS, dreamTools, guardDreamReviewTools, historyTools, type DreamRuntime, type DreamSources } from "./dream-tools.js";
import type { SituationStore } from "./situation-store.js";
import { situationTools, SITUATION_INSTRUCTIONS } from "./situation-tools.js";
import type { ActivityStore } from "./activity-store.js";
import { activityTools, ACTIVITY_INSTRUCTIONS } from "./activity-tools.js";
import { contextHooks, contextTools, type ContextHealth } from "./context-health.js";
import { WEB_INSTRUCTIONS, ownerWroteUrl, webForeground, webTools, type WebUsageStore } from "./web-search.js";
import type { BriefStore } from "./brief-store.js";
import { briefTools, guardBriefReviewTools, BRIEF_INSTRUCTIONS } from "./brief-tools.js";
import { journalTools, JOURNAL_INSTRUCTIONS, type JournalRuntime } from "./journal.js";
import type { CodingStore } from "./coding-store.js";
import type { CodingRuntime } from "./coding-runtime.js";
import { codingExtension, codingSubagentExtension, codingOwnerTools, CODING_OWNER_INSTRUCTIONS } from "./coding-tools.js";
import { cloudMachineTools, type CloudMachines } from "./cloud-machines.js";
import type { BrowserStore } from "./browser-store.js";
import type { BrowserRuntime } from "./browser-runtime.js";
import { browserExtension, browserOwnerTools, BROWSER_OWNER_INSTRUCTIONS } from "./browser-tools.js";
import { SUBAGENT_INSTRUCTIONS, type SubagentRuntime } from "./subagent-runtime.js";
import { assistantSubagentExtension } from "./subagent-profile.js";
import type { SubagentScope } from "./subagent-types.js";
import type { ChatLog } from "./chat.js";
import { speechWordTools, type SpeechWordStore } from "./speech-words.js";
import { t3CodeTools, type T3CodeStore } from "./t3-code.js";
import { t3ActionTools, type T3ActionRequests } from "./t3-actions.js";
import { t3WatchTools, type T3Watcher } from "./t3-watch.js";
import { widgetTools, type WidgetStore } from "./widget.js";

/**
 * Tool profiles: who can call what. Each kind of conversation gets one extension, and this module is the one place
 * that assembles their tool lists, guard wrappers, and instruction sections. `tests/profiles.test.ts` builds the
 * same profiles and compares them with `tests/fixtures/capabilities.json`, so a change here appears as a diff of
 * that file.
 */

/** The stores and runtimes the profiles close over. All are built before `buildProfiles` runs; no tool factory calls them at build time. */
export interface ProfileSources {
  store: Store;
  timezone: string;
  /** Wakes the coordinator. */
  wake: () => Promise<void>;
  notifyExecutor: () => void;
  calendarCredentials: () => string | undefined;
  /** The web search provider key. */
  webKey: () => string | undefined;
  /** The owner's foreground conversations and their entries, for the nightly run. */
  conversations: DreamSources["conversations"];
  /** Counts of what the provenance guard allowed and refused, for protected status. */
  provenance: ProvenanceCounts;
  companion: CompanionStore;
  proactive: ProactiveStore;
  situation: SituationStore;
  activity: ActivityStore;
  mail: MailStore;
  brief: BriefStore;
  dream: DreamStore;
  coding: CodingStore;
  browser: BrowserStore;
  journal: JournalRuntime;
  speechWords: SpeechWordStore;
  widgets: WidgetStore;
  t3: T3CodeStore;
  t3Requests: T3ActionRequests;
  t3Watch: T3Watcher;
  cloud: CloudMachines;
  webUsage: WebUsageStore;
  decisions: Decisions;
  history: HistoryIndex;
  contextHealth: ContextHealth;
  chat: ChatLog;
  planningRuntime: PlanningRuntime;
  mailRuntime: MailRuntime;
  codingRuntime: CodingRuntime;
  browserRuntime: BrowserRuntime;
  dreamRuntime: DreamRuntime;
  subagents: SubagentRuntime;
}

/** The extensions, in the order the coordinator installs them. */
export interface Profiles {
  /** The owner conversation. It is also the default of every conversation that selects no other profile. */
  owner: Extension;
  /** A background review, the nightly run included: the slim tool list. */
  background: Extension;
  /** A coding task's own conversation. */
  coding: Extension;
  /** A browser task's own conversation. */
  browser: Extension;
  /** The subagent tools and tasks. The owner and coding profiles carry these tools; this installs their tasks. */
  delegation: Extension;
  /** A subagent of the owner conversation. */
  assistantChild: Extension;
  /** A subagent of a coding task. */
  codingChild: Extension;
  /** The guards this module wrapped around each tool object, innermost first. For the capability manifest only. */
  guards(tool: ToolRegistration): readonly string[];
}

/** Tools a background review gets only when it is the nightly run: it may look into the owner's open questions and read older digests; other reviews may not. */
export const NIGHTLY_ONLY_TOOLS = ["web_search", "read_web_page", "search_history", "read_history"];

/** Who may delegate: a running coding task's conversation, or a channel's own foreground conversation. */
export function subagentScope(stores: { store: Store; coding: CodingStore }, parentSessionId: string): SubagentScope {
  const coding = stores.coding.forSession(parentSessionId);
  if (coding) {
    if (!coding.run) throw new StateError(403, "This conversation owns no active coding run");
    const task = stores.coding.assertRunning(coding.taskId, coding.run.runId);
    return { kind: "coding", parentSessionId, taskId: task.taskId, runId: task.run!.runId, deadlineAt: task.run!.assignment.deadlineAt };
  }
  const channel = stores.store.channelForSession(parentSessionId);
  if (stores.store.isBackgroundSession(parentSessionId) || stores.store.session(channel) !== parentSessionId) throw new StateError(403, "Only an original foreground parent may delegate");
  return { kind: "assistant", parentSessionId, channel };
}

/**
 * Builds every profile. The order of wrapping is behaviour: the last guard applied runs first. The calls below keep
 * the guard functions' own names; each is the real guard, and also notes its name against the tools it wrapped.
 */
export function buildProfiles(s: ProfileSources): Profiles {
  const applied = new WeakMap<ToolRegistration, readonly string[]>();
  /** The same guard, noting `name` against each tool object it replaced. A guard that returns a tool unchanged did not wrap it. */
  const noted = <Rest extends unknown[]>(name: string, guard: (tools: ToolRegistration[], ...rest: Rest) => ToolRegistration[]) => (tools: ToolRegistration[], ...rest: Rest): ToolRegistration[] => {
    const wrapped = guard(tools, ...rest);
    wrapped.forEach((tool, index) => { if (tool !== tools[index]) applied.set(tool, [...(applied.get(tools[index]!) ?? []), name]); });
    return wrapped;
  };
  const background = noted("background", guardBackgroundTools), provenance = noted("provenance", guardProvenance);
  const planningReview = noted("planning-review", guardPlanningReviewTools), mailReview = noted("mail-review", guardMailReviewTools);
  const briefReview = noted("brief-review", guardBriefReviewTools), dreamReview = noted("dream-review", guardDreamReviewTools);

  const web = webTools({ key: s.webKey, usage: s.webUsage, foreground: webForeground(id => s.store.isBackgroundSession(id) && !s.dream.ownsSession(id)),
    // A link the owner wrote in the shared chat may be read. Background sessions, the nightly run included, get no owner links.
    ownerWrote: (url, id) => !s.store.isBackgroundSession(id) && ownerWroteUrl(s.chat.ownerTexts(new URL(url).hostname), url) });
  const decision = decisionTools(s.decisions);
  const assistantChild = assistantSubagentExtension(s.store, s.timezone, s.wake, (api, context) => s.subagents.childScope(api, context), web, decision);
  const codingChild = codingSubagentExtension(s.codingRuntime, (api, context) => s.subagents.childScope(api, context));
  const delegation = s.subagents.extension();
  const codingBase = codingExtension(s.codingRuntime);
  const codingProfile: Extension = { ...codingBase,
    tools: [...codingBase.tools ?? [], ...delegation.tools ?? []],
    sections: [...codingBase.sections ?? [], { key: "delegation", tag: false, render: () => SUBAGENT_INSTRUCTIONS }],
  };
  const browserProfile = browserExtension(s.browserRuntime);
  const foregroundTools = [...assistantTools(s.store, s.timezone, s.wake), ...coreContextTools(s.wake), ...companionTools(s.companion, s.wake), ...codingOwnerTools(s.codingRuntime), ...browserOwnerTools(s.browserRuntime), ...situationTools(s.store, s.situation, s.calendarCredentials), ...speechWordTools(s.speechWords, id => s.store.isBackgroundSession(id)), ...activityTools(s.store, s.activity, s.timezone, s.notifyExecutor), ...journalTools(s.journal, id => s.store.isBackgroundSession(id)), ...widgetTools(s.widgets, s.wake), ...t3CodeTools(s.t3, () => s.t3Watch.recent()), ...t3ActionTools(s.t3, s.t3Requests, s.t3Watch), ...t3WatchTools(s.t3, s.t3Watch), ...cloudMachineTools(s.cloud, s.t3Watch), ...web, ...decision, ...historyTools(s.dream, s.history, id => s.store.isBackgroundSession(id)), ...contextTools(s.contextHealth, id => !s.store.isBackgroundSession(id)), ...delegation.tools ?? []];
  const guardedProactiveTools = dreamReview(briefReview(mailReview(planningReview(proactiveTools(s.proactive, s.wake), s.planningRuntime), s.mailRuntime), s.brief), s.dream);
  const briefSources = { brief: s.brief, situation: s.situation, mail: s.mail, planning: s.planningRuntime, calendarCredentials: s.calendarCredentials, activity: s.activity, dream: s.dream };
  const dreamSources = { dream: s.dream, mail: s.mail, situation: s.situation, activity: s.activity,
    tasks: () => [
      ...s.coding.tasks().map(task => ({ kind: "coding" as const, id: task.taskId, status: task.status, prompt: task.prompt.slice(0, 300), result: task.result?.summary?.slice(0, 400) ?? null, updatedAt: task.updatedAt })),
      ...s.browser.tasks().map(task => ({ kind: "browser" as const, id: task.taskId, status: task.status, prompt: task.prompt.slice(0, 300), result: (task.result as { summary?: string } | undefined)?.summary?.slice(0, 400) ?? task.issue ?? null, updatedAt: task.updatedAt })),
    ],
    conversations: s.conversations };
  const dreamExtra = (session: string, tool: string) => NIGHTLY_ONLY_TOOLS.includes(tool) && s.dream.ownsSession(session);
  const umpiExtension: Extension = { name: "umpi", hooks: contextHooks({ health: s.contextHealth, isForeground: id => !s.store.isBackgroundSession(id), summaryFor: instructions => s.dreamRuntime.summaryFor(instructions) }), tools: provenance([...background(foregroundTools, s.proactive, dreamExtra), ...guardedProactiveTools, ...planningTools(s.planningRuntime), ...mailTools(s.mailRuntime), ...briefTools(briefSources), ...dreamTools(dreamSources)], s.store, s.provenance),
    sections: [{ key: "umpi", tag: false, render: () => `${ASSISTANT_INSTRUCTIONS}\n${PROVENANCE_INSTRUCTIONS}\n${COMPANION_INSTRUCTIONS}\n${PROACTIVE_INSTRUCTIONS}\n${PLANNING_INSTRUCTIONS}\n${MAIL_INSTRUCTIONS}\n${SITUATION_INSTRUCTIONS}\n${ACTIVITY_INSTRUCTIONS}\n${WEB_INSTRUCTIONS}\n${DECISION_INSTRUCTIONS}\n${JOURNAL_INSTRUCTIONS}\n${BRIEF_INSTRUCTIONS}\n${DREAM_INSTRUCTIONS}\n${CODING_OWNER_INSTRUCTIONS}\n${BROWSER_OWNER_INSTRUCTIONS}\n${SUBAGENT_INSTRUCTIONS}\nOwner timezone: ${s.timezone}.` }, coreContextSection, { key: "lessons", tag: false, render: () => s.dream.playbook() }, { key: "response-style", tag: false, render: () => RESPONSE_STYLE_INSTRUCTIONS }] };
  // Background reviews get only the tools they may use: every request carries its tool list, and a review
  // pays for it in full on each cold start.
  const reviewTools = [...background(foregroundTools, s.proactive, dreamExtra).filter(tool => backgroundTools.has(tool.name) || NIGHTLY_ONLY_TOOLS.includes(tool.name)),
    ...guardedProactiveTools, ...planningTools(s.planningRuntime), ...mailTools(s.mailRuntime), ...briefTools(briefSources), ...dreamTools(dreamSources)];
  const backgroundExtension: Extension = { name: "umpi-background", hooks: umpiExtension.hooks, tools: reviewTools,
    sections: [{ key: "umpi", tag: false, render: () => `${ASSISTANT_INSTRUCTIONS}\n${PROACTIVE_INSTRUCTIONS}\n${PLANNING_INSTRUCTIONS}\n${MAIL_INSTRUCTIONS}\n${SITUATION_INSTRUCTIONS}\n${DECISION_INSTRUCTIONS}\n${BRIEF_INSTRUCTIONS}\n${DREAM_INSTRUCTIONS}\nOwner timezone: ${s.timezone}.` }, coreContextSection, { key: "lessons", tag: false, render: () => s.dream.playbook() }, { key: "response-style", tag: false, render: () => RESPONSE_STYLE_INSTRUCTIONS }] };
  return { owner: umpiExtension, background: backgroundExtension, coding: codingProfile, browser: browserProfile, delegation, assistantChild, codingChild, guards: tool => applied.get(tool) ?? [] };
}
