// Reconstructs a remote host's lifecycle event feed from its own live connection, with no server install and no
// credentials: getPaseoClient(serverId).observeEvents() borrows the connection the app already holds. Only three session
// subscriptions carry per-agent lifecycle over the wire — agent_attention_required (a finished or errored turn, or a new
// permission wait), agent_permission_request and agent_permission_resolved — the same ones the plugin's own server uses
// (server/attention.ts). Plain turn_started events are not delivered to a session subscriber, so this feed reconstructs
// turn_completed / turn_failed from attention reasons and the permission pair directly.
import { getPaseoClient } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import type { TelemetryEvent } from "../shared/telemetry";

/** Newest-first rolling cap, matching the server telemetry feed's retention (shared/telemetry.ts MAX_EVENTS). */
export const MAX_REMOTE_EVENTS = 500;

/** One reconstructed lifecycle event; `type` reuses the telemetry vocabulary so it feeds ActivityFeed and decisionSignals. */
export interface RemoteEvent {
  id: string;
  agentId: string;
  at: string;
  type: TelemetryEvent["type"];
  permissionAllowed?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isoAt(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

/** Maps one session outbound message to a reconstructed event, or null when it is not one we show. */
function mapMessage(message: unknown, nextId: () => string): RemoteEvent | null {
  const event = asRecord(message);
  const payload = asRecord(event.payload);
  const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
  if (!agentId || agentId.length > 256) return null;
  const at = isoAt(payload.timestamp);
  switch (event.type) {
    case "agent_permission_request":
      return { id: nextId(), agentId, at, type: "permission_requested" };
    case "agent_permission_resolved":
      return { id: nextId(), agentId, at, type: "permission_resolved", permissionAllowed: asRecord(payload.resolution).behavior === "allow" };
    case "agent_attention_required": {
      // A permission wait is already covered by agent_permission_request; mapping it here too would double every approval.
      if (payload.reason === "finished") return { id: nextId(), agentId, at, type: "turn_completed" };
      if (payload.reason === "error") return { id: nextId(), agentId, at, type: "turn_failed" };
      return null;
    }
    default:
      return null;
  }
}

/**
 * Keeps a rolling list (newest first, capped) of reconstructed lifecycle events for one remote host. The subscription is
 * released and the list cleared whenever the host changes or the screen unmounts.
 */
export function useRemoteEvents(serverId: string | null, online: boolean): RemoteEvent[] {
  const [events, setEvents] = useState<RemoteEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!serverId || !online) return;
    let api;
    try {
      api = getPaseoClient(serverId);
    } catch {
      return;
    }
    if (typeof api.observeEvents !== "function") return;
    let handle;
    try {
      handle = api.observeEvents(["agent_attention_required", "agent_permission_request", "agent_permission_resolved"]);
    } catch {
      return;
    }
    let seq = 0;
    const nextId = () => `${serverId}:${Date.now()}:${seq++}`;
    const unsubscribe = handle.subscribe({
      snapshot: () => {},
      update: (message) => {
        const mapped = mapMessage(message, nextId);
        if (mapped) setEvents((previous) => [mapped, ...previous].slice(0, MAX_REMOTE_EVENTS));
      },
      error: () => {},
    });
    return () => {
      unsubscribe();
      void handle.release().catch(() => {});
    };
  }, [serverId, online]);
  return events;
}
