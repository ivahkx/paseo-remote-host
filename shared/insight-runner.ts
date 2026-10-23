// Who analyses a remote session, and where. The trajectory is read from the observed host (shared/trajectory-build.ts),
// but the model always runs on the host this screen is on: this file never receives the remote API. It is the client-side
// half of Agent Observatory's server/insight-runner.ts, with the Grok CLI path dropped (that one needs a binary on the
// daemon, which a plugin with no server cannot reach) and every Node API removed. Type-only imports, so nothing from the
// client bundle enters at run time.
import { t } from "./text";
import { z } from "zod";
import type { PaseoAgent, PaseoAgentCreateOptions, PaseoAgentHandle, PaseoAgentRunResult, PaseoApi } from "@getpaseo/client";
import { insightReportSchema, type InsightJob, type InsightRunnerInfo } from "./insights";
import { defaultModelOf, providerModelId } from "./provider-model";
import { redactSecrets } from "./redact";

type AgentMode = PaseoAgent["availableModes"][number];
type ProviderSnapshot = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>;
type DaemonConfig = Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"];
/** How a runner will analyse: `read` = a verified read-only mode; `ask` = approval-gated, every request denied. */
export type AnalystAccess = "read" | "ask";

/** What `auto` may run, in order: Claude Code, Codex, then custom providers that extend them (`extends` in the daemon config). */
const AUTO_BASES = ["claude", "codex"] as const;
/** Providers whose daemon client turns auto-accept on for an unattended child unless the request sets it. */
const AUTO_ACCEPT_BASES = new Set(["acp", "copilot", "opencode"]);
/**
 * Profile feature switches an analysis keeps: speed and reasoning effort only. Everything else (auto-accept, plan or
 * agent switches, provider-specific access settings) belongs to coding sessions, not to a read of an untrusted transcript.
 */
const INSIGHT_FEATURES = new Set(["fast_mode", "fast", "service_tier", "reasoning", "reasoning_effort", "effort", "thinking"]);
/** Codex's read-only sandbox, applied on top of its default mode (create rejects modes a provider does not list). */
const CODEX_READ_ONLY_OPTIONS = { sandbox_mode: "read-only", approval_policy: "never" } as const;

const clipped = (value: string | undefined | null, length: number) => value?.trim().slice(0, length) || null;
const safeError = (value: unknown, length = 300) => redactSecrets(value instanceof Error ? value.message : String(value)).slice(0, length);
const validId = (value: string | undefined | null, max: number) => value && value.length <= max ? value : null;

/** The allowlisted switches with plain values; `auto_accept: false` (switching approval prompts back on) always passes. */
export function filterInsightFeatures(values: Record<string, unknown> = {}): Record<string, unknown> {
  const plain = (value: unknown) => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 120);
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => (INSIGHT_FEATURES.has(key) && plain(value)) || (key === "auto_accept" && value === false)));
}

export interface InsightAnalysisMode { modeId: string | null; access: AnalystAccess; providerOptions?: Record<string, unknown>; unsafe?: true }
/**
 * The mode an analysis runs in, always explicit (creation otherwise inherits a default that may edit without asking).
 * Only modes whose restriction is known qualify: Codex's read-only sandbox, an `ask` mode, a `default` mode the provider
 * marks safe, or a plan mode. A mode id alone proves nothing and a provider with no listed modes cannot be pinned to one:
 * both are `unsafe` and never run.
 */
export function insightAnalysisMode(modes: readonly AgentMode[], provider: { codex?: boolean } = {}): InsightAnalysisMode {
  const usable = modes.filter(mode => !(mode as AgentMode & { isUnattended?: boolean }).isUnattended && mode.colorTier !== "dangerous");
  if (provider.codex && usable.some(mode => mode.id === "auto")) return { modeId: "auto", access: "read", providerOptions: { ...CODEX_READ_ONLY_OPTIONS } };
  const ask = usable.find(mode => mode.id === "ask");
  if (ask) return { modeId: ask.id, access: "read" };
  const gated = usable.find(mode => mode.id === "default" && mode.colorTier === "safe");
  if (gated) return { modeId: gated.id, access: "ask" };
  const plan = usable.find(mode => mode.id === "plan" || mode.colorTier === "planning");
  if (plan) return { modeId: plan.id, access: "read" };
  return { modeId: null, access: "ask", unsafe: true };
}

interface CatalogEntry {
  provider: string; label: string; enabled: boolean; status: string; error: string | null;
  modes: AgentMode[]; models: Array<{ id: string; label: string; isDefault: boolean }>;
  /** The built-in provider a custom one extends, from the daemon config. */
  extends: string | null;
}
const lineage = (entry: Pick<CatalogEntry, "provider" | "extends">) => [entry.provider, entry.extends].filter((id): id is string => !!id);
const analysisModeOf = (entry: CatalogEntry) => insightAnalysisMode(entry.modes, { codex: lineage(entry).includes("codex") });
/** An analysis never auto-accepts: ACP and OpenCode clients otherwise switch it on for unattended children. */
const lockedFeatures = (entry: CatalogEntry): Record<string, unknown> => lineage(entry).some(id => AUTO_ACCEPT_BASES.has(id)) ? { auto_accept: false } : {};

function normalizeModels(entry: ProviderSnapshot["entries"][number], snapshot: ProviderSnapshot): CatalogEntry["models"] {
  const compact = snapshot.compactSnapshot?.entries.find(candidate => candidate.provider === entry.provider);
  const raw = entry.models?.length ? entry.models : compact?.models ?? [];
  const seen = new Set<string>();
  return raw.flatMap(model => {
    if (!validId(model.id, 240) || seen.has(model.id)) return [];
    seen.add(model.id);
    return [{ id: model.id, label: clipped(model.label, 240) ?? model.id, isDefault: !!model.isDefault }];
  }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).slice(0, 150);
}

function withTimeout<T>(request: Promise<T>, message: string, ms = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([request, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** Just the part of the host API the analyst reads; the same shape `getPaseoClient(hostId)` and `usePaseo()` return. */
export type AnalystApi = Pick<PaseoApi, "config" | "providers" | "agents" | "workspaces">;

/** What will run an analysis on this host, with the mode it is pinned to. */
export interface AnalystPlan {
  info: InsightRunnerInfo;
  access: AnalystAccess;
  featureValues: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

async function readCatalog(paseo: AnalystApi): Promise<CatalogEntry[]> {
  // The snapshot is what an analysis actually needs; the daemon config only adds the `enabled` override and the built-in
  // a custom provider `extends`. A client may not be allowed to read config at all, and losing that is not worth losing
  // the tab over: without it a custom provider simply is not picked automatically, which is the safe way to be wrong.
  const [config, snapshot] = await withTimeout(
    Promise.all([
      (paseo.config.get() as Promise<{ config: DaemonConfig }>).then(answer => answer.config, () => null),
      paseo.providers.snapshot() as Promise<ProviderSnapshot>,
    ]),
    t("sharedInsightRunner.catalogTimeout"),
  ).catch((error: unknown) => { throw new Error(t("sharedInsightRunner.catalogFailed", { value1: safeError(error) })); });
  const providers = config?.providers as Record<string, { enabled?: boolean; extends?: string } | undefined> | undefined;
  const entries = snapshot.entries.length ? snapshot.entries : (snapshot.compactSnapshot?.entries ?? []);
  return entries.filter(entry => validId(entry.provider, 120)).map(entry => {
    const compact = snapshot.compactSnapshot?.entries.find(candidate => candidate.provider === entry.provider);
    const full = snapshot.entries.find(candidate => candidate.provider === entry.provider) ?? { ...entry, models: undefined };
    return {
      provider: entry.provider, label: clipped(entry.label, 160) ?? entry.provider,
      enabled: entry.enabled !== false && providers?.[entry.provider]?.enabled !== false,
      status: entry.status, error: entry.error ? safeError(entry.error) : null,
      modes: (entry.modes ?? compact?.modes ?? []) as AgentMode[], models: normalizeModels(full as ProviderSnapshot["entries"][number], snapshot),
      extends: validId(providers?.[entry.provider]?.extends, 120) ?? null,
    };
  });
}

/** Why this provider cannot analyse, or null when it can. */
function unavailable(entry: CatalogEntry | undefined): string | null {
  if (!entry) return t("sharedInsightRunner.noProvider");
  if (!entry.enabled) return t("sharedInsightRunner.notEnabled");
  if (entry.status === "unavailable" || entry.status === "error") return clipped(entry.error, 300) ?? t("sharedInsightRunner.unavailable");
  if (!entry.modes.length) return t("sharedInsightRunner.noModes");
  if (analysisModeOf(entry).unsafe) return t("sharedInsightRunner.unsafe");
  return null;
}

/**
 * The provider this host analyses with: Claude Code, Codex, then a custom provider that extends one of them, each with
 * its default model; within a rank, read-only modes come first. Other providers are never picked automatically.
 * Throws with the reason when nothing here can run one.
 */
export async function resolveAnalyst(paseo: AnalystApi): Promise<AnalystPlan> {
  const catalog = await readCatalog(paseo);
  const rank = (entry: CatalogEntry) => {
    const own = AUTO_BASES.indexOf(entry.provider as typeof AUTO_BASES[number]);
    if (own >= 0) return own;
    const base = AUTO_BASES.indexOf(entry.extends as typeof AUTO_BASES[number]);
    return base >= 0 ? AUTO_BASES.length + base : -1;
  };
  const entry = catalog.map((candidate, index) => ({ entry: candidate, index, rank: rank(candidate), read: analysisModeOf(candidate).access === "read" ? 0 : 1 }))
    .filter(item => item.rank >= 0 && !unavailable(item.entry))
    .sort((a, b) => a.rank - b.rank || a.read - b.read || a.index - b.index)[0]?.entry;
  if (!entry) throw new Error(t("sharedInsightRunner.noRunner"));
  const model = defaultModelOf(entry.models);
  const { modeId, access, providerOptions } = analysisModeOf(entry);
  // "Claude Code" already names the provider `claude`; only add the id when the label does not carry it (case aside).
  const named = entry.label.toLowerCase().includes(entry.provider.toLowerCase());
  const label = [entry.label, named ? null : entry.provider, entry.models.find(candidate => candidate.id === model)?.label ?? model].filter(Boolean).join(" · ");
  return {
    info: { kind: "provider", label: clipped(label, 160) ?? entry.provider, provider: entry.provider, model, thinkingOptionId: null, modeId, sessionAgentId: null },
    access, featureValues: lockedFeatures(entry), ...(providerOptions ? { providerOptions } : {}),
  };
}

const usageNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function snapshotUsage(snapshot: PaseoAgent | null): InsightJob["usage"] {
  const usage = snapshot?.lastUsage;
  return usage ? { inputTokens: usageNumber(usage.inputTokens), outputTokens: usageNumber(usage.outputTokens), costUsd: usageNumber(usage.totalCostUsd) } : null;
}

export interface AnalysisRunOptions<T> {
  /** The host this screen is on. The observed host's API never reaches this function. */
  paseo: AnalystApi;
  plan: AnalystPlan;
  prompt: string;
  systemPrompt: string;
  title: string;
  /** Carried on the temporary session so a crashed run is recognizable in the host's own agent list. */
  labels: Record<string, string>;
  parse: (text: string) => T;
  signal: AbortSignal;
  onSession?: (runner: InsightRunnerInfo) => void;
  onRetry?: () => void;
  timeoutMs?: number;
  now?: () => number;
}
export interface AnalysisRunResult<T> { value: T; usage: InsightJob["usage"]; runner: InsightRunnerInfo }

/** The newest workspace this host has open; an analysis has no project of its own and borrows one to live in. */
async function analystWorkspace(paseo: AnalystApi): Promise<string> {
  const page = await withTimeout(paseo.workspaces.list({ sort: [{ key: "activity_at", direction: "desc" }], page: { limit: 50 } }), t("sharedInsightRunner.catalogTimeout"))
    .catch((error: unknown) => { throw new Error(t("sharedInsightRunner.catalogFailed", { value1: safeError(error) })); });
  const open = page.entries.filter(workspace => !workspace.archivingAt);
  const newest = [...open].sort((a, b) => Date.parse(b.activityAt ?? "") - Date.parse(a.activityAt ?? "") || 0)[0] ?? open[0];
  if (!newest) throw new Error(t("sharedInsightRunner.noWorkspace"));
  return newest.id;
}

/**
 * Owns precisely one temporary session on this host, including its single structured-output retry, and archives it
 * whatever happens. Every tool request it makes is denied: the trajectory it reviews was already collected, and the
 * project it describes is on another machine.
 */
export async function runAnalysis<T>(options: AnalysisRunOptions<T>): Promise<AnalysisRunResult<T>> {
  const { paseo, plan, signal } = options;
  // Never create a helper whose mode is not pinned to a verified restricted one.
  if (!plan.info.provider || !plan.info.modeId) throw new Error(t("sharedInsightRunner.unverifiedMode"));
  if (signal.aborted) throw new Error(t("sharedInsightRunner.canceled"));
  const now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 15 * 60_000, deadline = now() + timeoutMs;
  let handle: PaseoAgentHandle | undefined, terminated: Error | undefined, denials = 0;
  let rejectStop!: (error: Error) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  void stop.catch(() => {});
  const terminate = (message: string) => { terminated ??= new Error(message); rejectStop(terminated); };
  const cancel = () => terminate(t("sharedInsightRunner.canceled"));
  const timer = setTimeout(() => terminate(t("sharedInsightRunner.timedOut")), timeoutMs);
  signal.addEventListener("abort", cancel, { once: true });
  const remaining = () => { if (signal.aborted) cancel(); if (now() >= deadline) terminate(t("sharedInsightRunner.timedOut")); if (terminated) throw terminated; return Math.max(1, deadline - now()); };
  const guarded = async <V>(operation: Promise<V>): Promise<V> => { remaining(); return Promise.race([operation, stop]); };
  const archive = async (target: PaseoAgentHandle) => {
    try { await withTimeout(target.archive(), t("sharedInsightRunner.archiveTimeout"), 5000); }
    catch (error) { console.warn(t("sharedInsightRunner.archiveFailed", { value1: safeError(error) })); }
  };
  const wait = async (initial?: PaseoAgentRunResult): Promise<PaseoAgentRunResult> => {
    let result = initial;
    for (;;) {
      result ??= await guarded(handle!.waitForFinish(remaining()));
      if (result.status === "timeout") throw new Error(t("sharedInsightRunner.timedOut"));
      if (result.status === "error") throw new Error(t("sharedInsightRunner.runFailed", { value1: safeError(result.error ?? result.final?.lastError ?? t("sharedInsightRunner.unknownError"), 1200) }));
      if (result.status === "idle") return result;
      let permissions = result.final?.pendingPermissions ?? handle!.current()?.pendingPermissions ?? [];
      if (!permissions.length) permissions = (await guarded(handle!.refresh()))?.agent.pendingPermissions ?? [];
      if (!permissions.length) throw new Error(t("sharedInsightRunner.noAnswer"));
      for (const permission of permissions) {
        await guarded(handle!.respondToPermission({ requestId: permission.id, response: { behavior: "deny", message: t("sharedInsightRunner.denied") } }));
        denials++;
      }
      if (denials > 8) throw new Error(t("sharedInsightRunner.tooManyDenials"));
      result = undefined;
    }
  };
  try {
    remaining();
    const workspaceId = await guarded(analystWorkspace(paseo));
    const config: PaseoAgentCreateOptions["config"] = {
      provider: providerModelId(plan.info.provider, plan.info.model),
      modeId: plan.info.modeId, featureValues: filterInsightFeatures(plan.featureValues),
      ...(plan.providerOptions ? { options: plan.providerOptions as NonNullable<PaseoAgentCreateOptions["config"]>["options"] } : {}),
      systemPrompt: options.systemPrompt,
    };
    const creation = paseo.workspaces.ref(workspaceId).agents.create({
      config, title: options.title.slice(0, 60), prompt: options.prompt,
      outputSchema: z.toJSONSchema(insightReportSchema) as Record<string, unknown>, labels: options.labels,
    });
    // Creation may complete after cancellation. The resulting handle still belongs to us.
    void creation.then(async created => { if (terminated && !handle) await archive(created); }).catch(() => {});
    handle = await guarded(creation);
    const runner: InsightRunnerInfo = { ...plan.info, sessionAgentId: handle.id };
    options.onSession?.(runner);
    let result = await wait();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { remaining(); return { value: options.parse(result.lastMessage ?? ""), usage: snapshotUsage(result.final ?? handle.current()), runner }; }
      catch (error) {
        if (terminated || signal.aborted || attempt) throw error;
        options.onRetry?.();
        result = await wait(await guarded(handle.run(t("sharedInsightRunner.retry", { value1: safeError(error, 600) }), { timeoutMs: remaining() })));
      }
    }
    throw new Error(t("sharedInsightRunner.noReport"));
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", cancel);
    if (handle) await archive(handle);
  }
}
