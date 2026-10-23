// A one-line digest summary per row of the remote Sessions list, so a host can be reviewed without opening each session.
// It folds exactly as the detail's Recap tab does, over the same shared History: a tail-bounded read would miss a `Skill`
// call made at the start of a session and report a wrong zero, and this line now states the skill count explicitly.
// The cost is paid once per agent — opening that row's Recap tab afterwards reuses the same folded history.
import { useEffect, useRef, useState } from "react";
import { t } from "../shared/text";
import { buildDigest } from "../shared/digest-build/build";
import { readRemoteHistory } from "./remote-history-cache";
import { usageTokens } from "./remote-digest";
import { bigNumber } from "../shared/stats-view";
import { tokenTotal } from "../shared/tokens";
import { shortDuration } from "./ui";
import type { AgentRecord } from "../shared/model";
import type { Digest } from "../shared/digest";

/** Reads in flight at once, so a long list does not flood the borrowed connection. */
const CONCURRENCY = 3;
/**
 * Rows summarised at all, and how long a summary is reused before it is read again. The cap matches the shared history
 * cache, so summarising a list never evicts a history the detail is about to reuse.
 */
const MAX_ROWS_SUMMARISED = 20, TTL_MS = 60_000;

const cache = new Map<string, { at: number; line: string }>();

/** The row's one line, from a built digest. */
function summaryLine(digest: Digest, agent: AgentRecord): string | null {
  const totals = digest.totals, checks = totals.checksPassed + totals.checksFailed, errors = totals.errors + totals.failures;
  // The digest's own vocabulary and plural keys, so a row and the tiles it summarises always agree. Every part is left
  // out at zero except skills, which is the one the user wants stated even when nothing invoked one.
  // The same synthesis the Recap tab uses, so the row and the Tokens tile never disagree: a remote host has no provider
  // log history, and the totals come from the agent's own reported usage.
  const reported = digest.tokens ?? usageTokens(agent);
  const tokens = reported ? tokenTotal(reported.totals) : 0;
  const parts = [
    digest.activeMs ? shortDuration(digest.activeMs) : null,
    totals.turns ? `${t("coreAgentDigest.turns")} ${totals.turns}` : null,
    totals.thinking ? `${t("coreAgentDigest.thinking")} ${bigNumber(totals.thinking)}` : null,
    totals.tools ? `${t("coreAgentDigest.toolCalls")} ${bigNumber(totals.tools)}` : null,
    totals.tools ? `${t("coreAgentDigest.skillsTile")} ${totals.skills ?? 0}` : null,
    totals.subagents ? `${t("coreAgentDigest.subagents")} ${totals.subagents}` : null,
    // Files plus the line counts the Changes tile shows. `+added −removed` only: a diff has no separate "modified"
    // number — a modified line is one removal and one addition — so none is invented here.
    totals.files ? `${t("coreAgentDigest.changes")} ${bigNumber(totals.files)}${totals.added || totals.removed ? ` +${bigNumber(totals.added)} −${bigNumber(totals.removed)}` : ""}` : null,
    checks ? `${t("coreAgentDigest.checks")} ${totals.checksPassed}/${checks}` : null,
    tokens ? `${t("coreAgentDigest.tokens")} ${bigNumber(tokens)}` : null,
    errors ? `${t("coreAgentDigest.errorsTile")} ${errors}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

async function summarise(serverId: string, agent: AgentRecord): Promise<string | null> {
  const history = await readRemoteHistory(serverId, agent);
  if (!history.state.rows) return null;
  return summaryLine(buildDigest(history.state, { now: Date.now(), status: agent.rawStatus, activeTurn: !!agent.activeTurnStartedAt }, null), agent);
}

/**
 * Summaries by agent id for the rows given. A row with nothing ready yet is simply absent, so the list never draws a
 * placeholder that shifts when the real line arrives.
 */
export function useRemoteListDigests(serverId: string | null, agents: readonly AgentRecord[], enabled: boolean): ReadonlyMap<string, string> {
  const [lines, setLines] = useState<ReadonlyMap<string, string>>(() => new Map());
  const running = useRef(false);
  const ids = agents.slice(0, MAX_ROWS_SUMMARISED).map(agent => agent.id).join(",");

  useEffect(() => {
    if (!serverId || !enabled) return;
    let cancelled = false;
    const wanted = agents.slice(0, MAX_ROWS_SUMMARISED);
    const publish = () => {
      if (cancelled) return;
      const next = new Map<string, string>();
      for (const agent of wanted) { const hit = cache.get(`${serverId}:${agent.id}`); if (hit) next.set(agent.id, hit.line); }
      setLines(next);
    };
    publish();
    if (running.current) return;
    const now = Date.now();
    const queue = wanted.filter(agent => { const hit = cache.get(`${serverId}:${agent.id}`); return !hit || now - hit.at > TTL_MS; });
    if (!queue.length) return;
    running.current = true;
    let index = 0;
    const worker = async () => {
      while (!cancelled && index < queue.length) {
        const agent = queue[index++]!;
        try {
          const line = await summarise(serverId, agent);
          if (line) { cache.set(`${serverId}:${agent.id}`, { at: Date.now(), line }); publish(); }
        } catch { /* a row simply has no summary; the detail still reads the whole history */ }
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).finally(() => {
      running.current = false;
      publish();
    });
    return () => { cancelled = true; };
  }, [serverId, enabled, ids]);

  return lines;
}
