// A remote host's main-agent timeline, read client-side over the borrowed connection. This mirrors use-timeline.ts but
// swaps usePaseo() for getPaseoClient(serverId) — PaseoApiProvider is not exported, so the connection cannot be overridden
// through the usual hook. It reuses the same timeline store and cache, and keys the cache by serverId + agentId.
//
// Wire limitation: the subagent branch is dropped. use-timeline reads a subagent's timeline through providerTimelineRpc,
// which parses the provider's LOCAL session logs on the server — not available for a remote host. Only the main agent's
// projected timeline (the daemon's own live RPC + subscription) is available over the wire.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { createTimelineCache, createTimelineStore } from "./timeline-store";
import { useForeground } from "./use-foreground";

// One shared cache across hosts; entries are keyed by serverId + agentId and pruned by the cache's own limit/byte budget.
const remoteCache = createTimelineCache();

export function useRemoteTimeline(serverId: string, agentId: string, enabled = true) {
  const foreground = useForeground();
  const store = useMemo(
    () =>
      remoteCache.get(JSON.stringify([serverId, agentId]), (onChange) =>
        createTimelineStore(
          {
            // getPaseoClient() is resolved per call so a throw (host gone) surfaces as a timeline error, not a render crash.
            fetch: (input) => getPaseoClient(serverId).agents.ref(agentId).timeline.refetch({ ...input, projection: "projected" }),
            subscribe: (listener) => getPaseoClient(serverId).agents.ref(agentId).timeline.subscribe(listener),
          },
          { onChange, fallbackMs: 30_000 },
        ),
      ),
    [serverId, agentId],
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (enabled && foreground) return store.acquire();
  }, [store, enabled, foreground]);
  return { ...state, refresh: store.refresh, loadOlder: store.loadOlder, setViewState: store.setViewState };
}
