// A per-row metric strip for the remote Sessions list, so a host can be reviewed without opening each session. It folds
// exactly as the detail's Recap tab does, over the same shared History: a tail-bounded read would miss a `Skill` call
// made at the start of a session and report a wrong zero, so the skill count can be stated explicitly. The cost is paid
// once per agent — opening that row's Recap tab afterwards reuses the same folded history. Subagent rows are summarised
// too: the caller passes the rows actually on screen, so an expanded thread spends the budget on what is being read.
import { useEffect, useRef, useState } from "react";
import { buildDigest } from "../shared/digest-build/build";
import { readRemoteHistory } from "./remote-history-cache";
import { rowMetrics, type RowStats } from "../shared/row-stats";
import type { AgentRecord } from "../shared/model";

/** Reads in flight at once, so a long list does not flood the borrowed connection. */
const CONCURRENCY = 3;
/**
 * Rows summarised at all, and how long a summary is reused before it is read again. The cap matches the shared history
 * cache, so summarising a list never evicts a history the detail is about to reuse.
 */
const MAX_ROWS_SUMMARISED = 20, TTL_MS = 60_000;

const cache = new Map<string, { at: number; stats: RowStats }>();

async function summarise(serverId: string, agent: AgentRecord): Promise<RowStats | null> {
  const history = await readRemoteHistory(serverId, agent);
  if (!history.state.rows) return null;
  const stats = rowMetrics(buildDigest(history.state, { now: Date.now(), status: agent.rawStatus, activeTurn: !!agent.activeTurnStartedAt }, null), agent);
  return stats.metrics.length ? stats : null;
}

/**
 * Summaries by agent id for the rows given. A row with nothing ready yet is simply absent, so the list never draws a
 * placeholder that shifts when the real line arrives.
 */
export function useRemoteListDigests(serverId: string | null, agents: readonly AgentRecord[], enabled: boolean): ReadonlyMap<string, RowStats> {
  const [lines, setLines] = useState<ReadonlyMap<string, RowStats>>(() => new Map());
  const running = useRef(false);
  const ids = agents.slice(0, MAX_ROWS_SUMMARISED).map(agent => agent.id).join(",");

  useEffect(() => {
    if (!serverId || !enabled) return;
    let cancelled = false;
    const wanted = agents.slice(0, MAX_ROWS_SUMMARISED);
    const publish = () => {
      if (cancelled) return;
      const next = new Map<string, RowStats>();
      for (const agent of wanted) { const hit = cache.get(`${serverId}:${agent.id}`); if (hit) next.set(agent.id, hit.stats); }
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
          const stats = await summarise(serverId, agent);
          if (stats) { cache.set(`${serverId}:${agent.id}`, { at: Date.now(), stats }); publish(); }
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
