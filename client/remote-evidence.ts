// A remote host's session evidence (the Diagnostics tab's history section), computed client-side over the borrowed
// connection. It runs the same reader the local server's observatory.history.evidence RPC runs — fetchTrajectory with the
// same limits — and projects it into SessionEvidence exactly as server/history.ts does, so both screens agree.
import { useQuery } from "@tanstack/react-query";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { SessionEvidence } from "../shared/history";
import { fetchTrajectory } from "../shared/trajectory-build";

export function useRemoteEvidence(serverId: string, agentId: string, enabled: boolean) {
  return useQuery<SessionEvidence>({
    queryKey: ["remote-evidence", serverId, agentId],
    queryFn: async () => {
      // The same bounds server/history.ts passes.
      const trajectory = await fetchTrajectory(getPaseoClient(serverId), agentId, { limit: 300, maxCharacters: 80_000 });
      return { agentId, turns: trajectory.counts.userTurns, tools: trajectory.counts.tools, toolFailures: trajectory.counts.toolFailures,
        errors: trajectory.counts.errors, firstTimelineAt: trajectory.coverage.firstAt, lastTimelineAt: trajectory.coverage.lastAt,
        sampleSize: trajectory.rows.length, complete: trajectory.coverage.complete, hasOlder: trajectory.coverage.hasOlder,
        coverageReason: trajectory.coverage.reason, completionEvidence: trajectory.completionEvidence };
    },
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
}
