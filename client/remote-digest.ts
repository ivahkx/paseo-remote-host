// A remote host's 复盘 digest, built entirely client-side: the timeline is read through the borrowed connection
// (getPaseoClient) with the same reader and fold the plugin server uses, then assembled by the same buildDigest.
// Two inputs the server adds are local-only and are deliberately left out — telemetry events (approvals / waiting time)
// and the provider-log token history — so those tiles stay empty rather than being fabricated.
import { useQuery } from "@tanstack/react-query";
import type { Digest } from "../shared/digest";
import { buildDigest } from "../shared/digest-build/build";
import { readRemoteHistory } from "./remote-history-cache";
import type { AgentRecord } from "../shared/model";
import type { TelemetryEvent } from "../shared/telemetry";
import { emptyTokenCounts } from "../shared/tokens";

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

export function useRemoteDigest(serverId: string, agent: AgentRecord, events: readonly TelemetryEvent[], enabled: boolean) {
  // Only the event kinds the activity builder reads, so an unrelated event does not re-run the whole fold.
  const relevant = events.filter(event => event.type !== "created" && event.type !== "archived");
  const signature = relevant.map(event => `${event.id}:${event.type}`).join("|");
  return useQuery<Digest>({
    queryKey: ["remote-digest", serverId, agent.id, signature],
    queryFn: async () => {
      // Shared with the Sessions list's row summaries: whichever surface read this agent first paid for the paging.
      const history = await readRemoteHistory(serverId, agent);
      // `rawStatus` is the daemon's own status field, the one the server passes. The events are the ones this screen
      // reconstructed from the host's own stream (client/remote-observation.ts), which is what gives the digest its turn
      // outcomes and its approval wait; the token history stays null and the totals come from the agent's reported usage.
      const digest = buildDigest(history.state, { now: Date.now(), status: agent.rawStatus, activeTurn: !!agent.activeTurnStartedAt, events: relevant }, null);
      return { ...digest, tokens: digest.tokens ?? usageTokens(agent) };
    },
    enabled,
    staleTime: 5_000,
    retry: 1,
  });
}
