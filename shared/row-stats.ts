// What a remote Sessions row says about a session, as data. Pure derivation over a folded digest: no React, no colour
// values, no host runtime — the hue names below are the same plain vocabulary shared/reply.ts and shared/stats-view.ts
// already use, and client/row-stats.tsx turns them into theme colours. Kept out of the renderer so the thresholds that
// decide what counts as alarming can be tested.
import { t } from "./text";
import { bigNumber } from "./stats-view";
import { emptyTokenCounts, tokenTotal } from "./tokens";
import { shortDuration } from "./stats-view";
import type { AgentRecord } from "./model";
import type { Digest } from "./digest";

/** The palette names client/kit.tsx understands. */
export type StatHue = "blue" | "sky" | "cyan" | "teal" | "green" | "amber" | "orange" | "red" | "fuchsia" | "violet" | "indigo" | "gray";

/**
 * The digest's token block from the agent's own reported usage (AgentUsage over the wire), when the provider reports any.
 * `cachedInputTokens` is the cached part of `inputTokens` — the same reading the plugin's own `totalTokens` (input + output)
 * assumes — so fresh input is the difference and `tokenInput`/`tokenTotal` still add up to what the header shows.
 * `calls`, `reasoning` and the per-call timing genuinely need the provider logs, so they stay zero and the Output rate tile
 * and per-call chart hide themselves rather than showing an invented number.
 */
export function usageTokens(agent: AgentRecord): NonNullable<Digest["tokens"]> | null {
  const { inputTokens, outputTokens, cachedInputTokens } = agent.usage;
  if (inputTokens === null && outputTokens === null) return null;
  const cacheRead = cachedInputTokens ?? 0, read = inputTokens ?? 0;
  const totals = emptyTokenCounts();
  totals.input = Math.max(0, read - cacheRead);
  totals.cacheRead = Math.min(cacheRead, read);
  totals.output = outputTokens ?? 0;
  // `source` names a provider log this did not come from; it is not rendered anywhere in the digest.
  return { source: "claude", totals, calls: [] };
}

export interface RowMetric {
  key: string;
  /** Shown before the value; omitted for the run time, which its clock already names. */
  label: string | null;
  value: string;
  hue: StatHue;
  icon?: string;
  /** Filled instead of tinted: a number the reader should not be able to skim past. */
  alert?: boolean;
}
/** `signature` lets the list decide whether a row needs drawing again without walking the metrics. */
export interface RowStats { metrics: readonly RowMetric[]; signature: string }

/** Failure rates worth filling in red rather than merely colouring, as a percentage of attempts. */
const TOOL_FAIL_ALERT = 20, CHECK_FAIL_ALERT = 50;

/**
 * One row's metrics, in a fixed left-to-right order. The order never changes with the values, so two rows can be
 * compared by position; what changes is which chips are present, because a metric that carries nothing is left out.
 * `skills` is the exception and is stated even at zero, as the one-line version already did.
 */
export function rowMetrics(digest: Digest, agent: AgentRecord): RowStats {
  const totals = digest.totals;
  const checks = totals.checksPassed + totals.checksFailed;
  const turnFails = digest.turns.filter(turn => turn.outcome === "failed").length;
  // Tool failures and runtime errors were summed into one "Errors" number before. They are different findings: a failed
  // tool call is work that has to be redone, an error is the session itself going wrong, so they are counted apart.
  const toolFailRate = totals.tools ? Math.round(totals.failures / totals.tools * 100) : 0;
  // The same synthesis the Recap tab uses, so the row and the Tokens tile never disagree: a remote host has no provider
  // log history, and the totals come from the agent's own reported usage.
  const reported = digest.tokens ?? usageTokens(agent);
  const tokens = reported ? tokenTotal(reported.totals) : 0;

  const metrics: (RowMetric | null)[] = [
    digest.activeMs ? { key: "time", label: null, icon: "Clock3", value: shortDuration(digest.activeMs), hue: "gray" } : null,
    totals.turns ? { key: "turns", label: t("coreAgentDigest.turns"), value: bigNumber(totals.turns), hue: "blue" } : null,
    turnFails ? { key: "turnFails", label: t("coreRemoteStats.turnFails"), value: bigNumber(turnFails), hue: "red", alert: true } : null,
    totals.tools ? { key: "tools", label: t("coreAgentDigest.toolCalls"), value: bigNumber(totals.tools), hue: "violet" } : null,
    totals.failures ? { key: "toolFails", label: t("coreRemoteStats.toolFails"),
      value: t("coreRemoteStats.withWait", { value1: bigNumber(totals.failures), value2: t("coreRemoteStats.rate", { value1: toolFailRate }) }),
      hue: "red", alert: toolFailRate >= TOOL_FAIL_ALERT } : null,
    // `checksPassed` / `checksFailed` count check *runs*, not the state they ended in: a test that failed and then passed
    // is one of each. 27 of 29 passing is the shape of a healthy red-green cycle, so a few failures are amber; a session
    // where most runs failed never got anything green and is filled.
    checks ? { key: "checks", label: t("coreAgentDigest.checks"), value: t("coreRemoteStats.ofChecks", { value1: totals.checksPassed, value2: checks }),
      hue: !totals.checksFailed ? "green" : totals.checksFailed * 100 >= checks * CHECK_FAIL_ALERT ? "red" : "amber",
      alert: totals.checksFailed * 100 >= checks * CHECK_FAIL_ALERT } : null,
    // Files plus the line counts the Changes tile shows. `+added −removed` only: a diff has no separate "modified"
    // number — a modified line is one removal and one addition — so none is invented here.
    totals.files ? { key: "changes", label: t("coreAgentDigest.changes"),
      value: totals.added || totals.removed
        ? t("coreRemoteStats.changeLines", { value1: bigNumber(totals.files), value2: bigNumber(totals.added), value3: bigNumber(totals.removed) })
        : bigNumber(totals.files), hue: "amber" } : null,
    totals.thinking ? { key: "thinking", label: t("coreAgentDigest.thinking"), value: bigNumber(totals.thinking), hue: "indigo" } : null,
    totals.tools ? { key: "skills", label: t("coreAgentDigest.skillsTile"), value: bigNumber(totals.skills ?? 0), hue: "teal" } : null,
    totals.subagents ? { key: "subagents", label: t("coreAgentDigest.subagents"), value: bigNumber(totals.subagents), hue: "fuchsia" } : null,
    // How much of the run was spent waiting on a person: the one number here that is not the agent's own doing.
    totals.approvals ? { key: "approvals", label: t("coreRemoteStats.approvals"),
      value: totals.waitMs ? t("coreRemoteStats.withWait", { value1: bigNumber(totals.approvals), value2: shortDuration(totals.waitMs) }) : bigNumber(totals.approvals),
      hue: "orange" } : null,
    // Context churn: each compaction is history the session can no longer see, and a reason later turns repeat earlier work.
    totals.compactions ? { key: "compactions", label: t("coreRemoteStats.compactions"), value: bigNumber(totals.compactions), hue: "sky" } : null,
    tokens ? { key: "tokens", label: t("coreAgentDigest.tokens"), value: bigNumber(tokens), hue: "cyan" } : null,
    totals.errors ? { key: "errors", label: t("coreAgentDigest.errorsTile"), value: bigNumber(totals.errors), hue: "red", alert: true } : null,
  ];
  const kept = metrics.filter((metric): metric is RowMetric => !!metric);
  return { metrics: kept, signature: kept.map(metric => `${metric.key}:${metric.value}:${metric.alert ? 1 : 0}`).join("|") };
}


/** The same numbers as one readable sentence, for the row's accessibility label. */
export const statsSentence = (stats: RowStats): string =>
  stats.metrics.map(metric => metric.label ? `${metric.label} ${metric.value}` : metric.value).join(" · ");
