// One folded timeline history per remote agent, shared by the Sessions list's per-row summaries and the detail's Recap
// tab. The first read of an agent is the expensive one (the reader pages backwards to MAX_ROWS / MAX_BYTES); afterwards
// the reader is handed the previous History and only reads what is new, so opening a row's Recap tab is effectively free.
import { getPaseoClient } from "@getpaseo/plugin/client";
import { fetchHistory, type History } from "../shared/digest-build/reader";
import { jsDigestEnv } from "../shared/digest-build/env";
import type { AgentRecord } from "../shared/model";

/** Histories kept at once. Compact facts only — no tool bodies, diffs or reasoning text survive a fold. */
const MAX_HISTORIES = 20;
const histories = new Map<string, History>();
/** One read per agent at a time, so the list and a detail opening together do not page the same timeline twice. */
const inFlight = new Map<string, Promise<History>>();

const keyOf = (serverId: string, agentId: string) => `${serverId}:${agentId}`;

export function readRemoteHistory(serverId: string, agent: AgentRecord): Promise<History> {
  const key = keyOf(serverId, agent.id);
  const running = inFlight.get(key);
  if (running) return running;
  const handle = getPaseoClient(serverId).agents.ref(agent.id);
  const pending = fetchHistory(options => handle.timeline.refetch(options), agent.id, agent.cwd ?? "", histories.get(key), jsDigestEnv)
    .then(history => {
      // Re-insert so the map orders by recency; the oldest unused history is dropped first.
      histories.delete(key);
      histories.set(key, history);
      while (histories.size > MAX_HISTORIES) histories.delete(histories.keys().next().value!);
      return history;
    })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, pending);
  return pending;
}

/** Whether this agent's history has already been paged, so a caller can tell a first read from a refresh. */
export const hasRemoteHistory = (serverId: string, agentId: string): boolean => histories.has(keyOf(serverId, agentId));
