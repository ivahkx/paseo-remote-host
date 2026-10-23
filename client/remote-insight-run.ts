// One analysis of one remote session, from the two connections the screen already holds: the trajectory is read from the
// observed host (`remote`), the model runs on the host this screen is on (`local`). The remote API reaches the reader and
// nothing else, so an analysis cannot create, write or spend anything on the machine it is about.
//
// A run outlives its tab. The detail screen mounts one tab at a time, so holding the state in the component would abort a
// run — and discard a finished report — the moment the user looked at the timeline. It lives in a small module store
// instead, keyed by host and session, the way client/remote-history-cache.ts keeps folded histories.
import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { pluginLanguageName } from "./i18n";
import { fetchTrajectory } from "../shared/trajectory-build";
import type { ResultApi } from "../shared/result-build";
import { assessTrajectory, buildAnalysisRequest, parseInsightText } from "../shared/insight-analysis";
import { resolveAnalyst, runAnalysis, type AnalystApi, type AnalystPlan } from "../shared/insight-runner";
import type { InsightEvidence, InsightJob, InsightReport, InsightRunnerInfo } from "../shared/insights";
import type { TrajectoryRow } from "../shared/trajectory";

/** Where the run is: reading the remote trajectory, or waiting on the model here. */
export type InsightStage = "idle" | "reading" | "analyzing";

export interface RemoteInsightState {
  stage: InsightStage;
  /** The finished report of the latest successful run, kept until the next one replaces it. */
  report: InsightReport | null;
  /** The excerpts the report may cite, as they were sent, so every ref resolves to the text the model actually saw. */
  evidence: readonly InsightEvidence[];
  coverage: { rows: number; truncated: boolean } | null;
  counts: { turns: number; tools: number } | null;
  runner: InsightRunnerInfo | null;
  usage: InsightJob["usage"];
  analyzedAt: string | null;
  /** The run failed; a report from an earlier one is left alone. */
  error: string | null;
  /** The trajectory is too thin to review, with the reason. Not an error: nothing went wrong. */
  notEligible: string | null;
}
const EMPTY: RemoteInsightState = { stage: "idle", report: null, evidence: [], coverage: null, counts: null, runner: null, usage: null, analyzedAt: null, error: null, notEligible: null };

/** Reports kept at once. Each carries its evidence window, so this is the one thing here worth bounding. */
const MAX_RUNS = 6;
interface Entry { state: RemoteInsightState; controller: AbortController | null }
const runs = new Map<string, Entry>();
const watchers = new Map<string, Set<() => void>>();

const keyOf = (serverId: string, agentId: string) => `${serverId}:${agentId}`;
const stateOf = (key: string): RemoteInsightState => runs.get(key)?.state ?? EMPTY;

function write(key: string, entry: Entry) {
  // Re-insert so the map orders by recency; the oldest finished run is dropped first, never a live one.
  runs.delete(key);
  runs.set(key, entry);
  for (const candidate of [...runs.keys()]) {
    if (runs.size <= MAX_RUNS) break;
    if (candidate !== key && !runs.get(candidate)?.controller) runs.delete(candidate);
  }
  for (const notify of watchers.get(key) ?? []) notify();
}
function patch(key: string, changes: Partial<RemoteInsightState>) {
  const entry = runs.get(key) ?? { state: EMPTY, controller: null };
  write(key, { ...entry, state: { ...entry.state, ...changes } });
}
function subscribe(key: string, notify: () => void) {
  let set = watchers.get(key);
  if (!set) { set = new Set(); watchers.set(key, set); }
  set.add(notify);
  return () => { set.delete(notify); if (!set.size) watchers.delete(key); };
}

const evidenceOf = (rows: readonly TrajectoryRow[]): InsightEvidence[] =>
  rows.map(row => ({ ref: row.ref, at: row.at, kind: row.kind, toolName: row.toolName, text: row.text.slice(0, 2000) }));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A cancel is the user's own doing, not a failure to report back at them. */
const canceled = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.message === t("sharedInsightRunner.canceled"));

export interface StartAnalysisOptions {
  /** Borrows the observed host's connection when the run starts. Lazy: that can throw, and a throw belongs in `error`. */
  remote: () => ResultApi;
  /** The host this screen is on — where the model runs. */
  local: AnalystApi;
  plan: AnalystPlan;
  serverId: string;
  agentId: string;
  agentTitle: string;
}
/** Starts a run, replacing whatever was running for this session. Resolves when it settles; progress goes to the store. */
async function analyze(options: StartAnalysisOptions): Promise<void> {
  const { remote, local, plan, serverId, agentId, agentTitle } = options;
  const key = keyOf(serverId, agentId);
  runs.get(key)?.controller?.abort();
  const controller = new AbortController();
  const signal = controller.signal;
  const live = () => runs.get(key)?.controller === controller;
  write(key, { state: { ...stateOf(key), stage: "reading", error: null, notEligible: null }, controller });
  try {
    // The same reader Diagnostics runs, with the wider window an analysis is worth.
    const trajectory = await fetchTrajectory(remote(), agentId, { limit: 400, maxCharacters: 160_000, signal });
    const assessment = assessTrajectory(trajectory);
    const counts = { turns: assessment.turnCount, tools: assessment.toolCount };
    if (!assessment.eligible) {
      if (live()) patch(key, { stage: "idle", counts, notEligible: assessment.reason });
      return;
    }
    const request = buildAnalysisRequest(trajectory, { language: currentLanguage(), languageName: pluginLanguageName() });
    const coverage = { rows: request.evidence.length, truncated: request.sampled || trajectory.coverage.truncated };
    if (!live()) return;
    patch(key, { stage: "analyzing", counts, coverage });
    const result = await runAnalysis({
      paseo: local, plan, prompt: request.prompt,
      // The safety-critical half of the instructions, repeated where the transcript it reviews cannot reach them.
      systemPrompt: [
        t("sharedInsightAnalysis.role", { language: currentLanguage(), languageName: pluginLanguageName() }),
        t("sharedInsightAnalysis.noTools"),
        t("sharedInsightAnalysis.remote"),
      ].join("\n\n"),
      title: t("coreRemoteInsights.sessionTitle", { value1: agentTitle || agentId }),
      labels: { "remote-host.role": "insight", "remote-host.server": serverId.slice(0, 120), "remote-host.agent": agentId.slice(0, 180) },
      parse: text => parseInsightText(text, request.references),
      signal,
      onSession: runner => { if (live()) patch(key, { runner }); },
    });
    if (!live()) return;
    patch(key, {
      stage: "idle", report: result.value.report, evidence: evidenceOf(request.evidence), coverage, counts,
      runner: result.runner, usage: result.value.usage ?? result.usage, analyzedAt: new Date().toISOString(), error: null, notEligible: null,
    });
  } catch (error) {
    if (live() && !canceled(error)) patch(key, { stage: "idle", error: message(error) });
  } finally {
    if (live()) write(key, { state: stateOf(key), controller: null });
  }
}

/** What this host would analyse with, read once the Analysis tab is open so the button can say so before it is pressed. */
export function useAnalyst(local: AnalystApi, hostId: string, enabled: boolean) {
  return useQuery<AnalystPlan>({
    queryKey: ["remote-analyst", hostId],
    queryFn: () => resolveAnalyst(local),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export interface RemoteInsightRun extends RemoteInsightState { busy: boolean; start: () => void; cancel: () => void }

export function useRemoteInsight(options: {
  remote: () => ResultApi;
  local: AnalystApi;
  serverId: string;
  agentId: string;
  agentTitle: string;
  plan: AnalystPlan | undefined;
}): RemoteInsightRun {
  const { remote, local, serverId, agentId, agentTitle, plan } = options;
  const key = keyOf(serverId, agentId);
  const state = useSyncExternalStore(
    useCallback(notify => subscribe(key, notify), [key]),
    useCallback(() => stateOf(key), [key]),
  );
  const start = useCallback(() => {
    if (!plan) return;
    void analyze({ remote, local, plan, serverId, agentId, agentTitle });
  }, [remote, local, plan, serverId, agentId, agentTitle]);
  // Aborting also archives the temporary session (shared/insight-runner.ts), so a cancel leaves nothing behind.
  const cancel = useCallback(() => {
    const entry = runs.get(key);
    if (!entry?.controller) return;
    entry.controller.abort();
    write(key, { state: { ...entry.state, stage: "idle" }, controller: null });
  }, [key]);
  return { ...state, busy: state.stage !== "idle", start, cancel };
}
