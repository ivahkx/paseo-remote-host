// Moved from server/turn-content.ts so the remote-host screen can fold a timeline it read over the wire. The only
// changes are the injected `hash` (node:crypto there, a pure-JS hash here) and structurally declared item/detail types,
// which the protocol's own `AgentTimelineItem` / `ToolCallDetail` satisfy — server/turn-content.ts still presents the
// original signature, so its callers and tests are untouched.
import { emptyStatsMetrics, type StatsMetrics, type StatsTool, type ToolKind } from "../stats";

/** The tool-call fields this reader looks at; the protocol's `ToolCallDetail` members are assignable to it. */
export interface TurnToolDetail {
  type?: string;
  filePath?: string;
  content?: string;
  unifiedDiff?: string;
  oldString?: string;
  newString?: string;
  exitCode?: number | null;
  toolName?: string;
}
/** The timeline fields this reader looks at; the protocol's `AgentTimelineItem` members are assignable to it. */
export interface TurnItem {
  type?: string;
  callId?: string;
  messageId?: string;
  name?: string;
  text?: string;
  message?: string;
  level?: string;
  status?: string;
  detail?: TurnToolDetail;
}

const MAX_ITEM_LINES = 20_000;

function itemKey(item: TurnItem, index: number, hash: (value: string) => string): string {
  if (item.type === "tool_call") return `tool:${item.callId}`;
  if ((item.type === "user_message" || item.type === "assistant_message") && item.messageId) return `msg:${item.messageId}`;
  const text = "text" in item && typeof item.text === "string" ? item.text
    : "message" in item && typeof item.message === "string" ? item.message : "";
  return `${item.type}:${index}:${hash(text).slice(0, 12)}`;
}

function toolKind(detail: TurnToolDetail): ToolKind {
  switch (detail.type) {
    case "shell": case "read": case "plan": return detail.type;
    case "edit": case "write": return "edit";
    case "search": return detail.toolName === "web_search" ? "web" : "search";
    case "fetch": return "web";
    case "sub_agent": return "agent";
    default: return "other";
  }
}

/** Empty text has no lines; a final newline terminates the last line instead of adding another one. */
function countLines(text: string | undefined, maximum: number): number {
  if (!text || maximum <= 0) return 0;
  let count = 0, start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    count++;
    if (count >= maximum) return maximum;
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    start = index + 1;
  }
  return count + (start < text.length ? 1 : 0);
}

function changedLines(detail: TurnToolDetail): { added: number; removed: number } {
  let added = 0, removed = 0;
  if (detail.type === "write") return { added: countLines(detail.content, MAX_ITEM_LINES), removed };
  if (typeof detail.unifiedDiff !== "string") {
    removed = countLines(detail.oldString, MAX_ITEM_LINES);
    added = countLines(detail.newString, MAX_ITEM_LINES - removed);
    return { added, removed };
  }
  // Read only the leading characters of each diff line and stop at the per-item budget.
  // This avoids allocating an array proportional to a possibly very large tool result.
  const diff = detail.unifiedDiff;
  for (let start = 0; start < diff.length;) {
    if (diff[start] === "+" && !diff.startsWith("+++", start)) added++;
    else if (diff[start] === "-" && !diff.startsWith("---", start)) removed++;
    if (added + removed >= MAX_ITEM_LINES) break;
    const end = diff.indexOf("\n", start);
    if (end < 0) break;
    start = end + 1;
  }
  return { added, removed };
}

/**
 * Extract the new suffix of a whole in-memory timeline. The caller persists only lastKey,
 * counters and tool names; message text, commands, output and file paths never leave this function.
 */
export function extractTurnContent(timeline: readonly TurnItem[], lastKey: string | null, hash: (value: string) => string): {
  metrics: StatsMetrics; tools: StatsTool[]; lastKey: string | null;
} {
  const metrics = emptyStatsMetrics(), tools = new Map<string, StatsTool>(), files = new Set<string>();
  const nextKey = timeline.length ? itemKey(timeline[timeline.length - 1]!, timeline.length - 1, hash) : null;
  let start = -1;
  if (lastKey !== null) {
    // Searching from the tail also chooses the last match if a provider repeats an ID.
    for (let index = timeline.length - 1; index >= 0; index--) {
      if ((index === timeline.length - 1 ? nextKey : itemKey(timeline[index]!, index, hash)) === lastKey) {
        start = index + 1;
        break;
      }
    }
  }
  if (start < 0) {
    for (let index = timeline.length - 1; index >= 0; index--) {
      if (timeline[index]!.type === "user_message") { start = index; break; }
    }
  }
  if (start >= 0) for (let index = start; index < timeline.length; index++) {
    const item = timeline[index]!;
    switch (item.type) {
      case "user_message": metrics.userMessages++; break;
      case "assistant_message": metrics.assistantMessages++; break;
      case "error": metrics.errors++; break;
      case "notification": if (item.level === "error") metrics.errors++; break;
      case "compaction": if (item.status === "completed") metrics.compactions++; break;
      case "tool_call": {
        const detail = item.detail ?? {}, kind = toolKind(detail), name = (item.name ?? "").trim().slice(0, 160).trim();
        const failed = item.status === "failed" || (detail.type === "shell" && detail.exitCode != null && detail.exitCode !== 0);
        metrics.toolCalls++;
        if (failed) metrics.toolFailures++;
        if (kind === "shell") metrics.shellCalls++;
        if (kind === "web") metrics.webCalls++;
        if (kind === "agent") metrics.subagentCalls++;
        if (detail.type === "edit" || detail.type === "write") {
          const lines = changedLines(detail);
          metrics.edits++;
          metrics.linesAdded += lines.added;
          metrics.linesRemoved += lines.removed;
          if (detail.filePath) files.add(detail.filePath);
        }
        const key = JSON.stringify([name, kind]);
        let tool = tools.get(key);
        if (!tool) { tool = { name, kind, calls: 0, failures: 0 }; tools.set(key, tool); }
        tool.calls++;
        if (failed) tool.failures++;
        break;
      }
    }
  }
  metrics.filesChanged = files.size;
  return { metrics, tools: [...tools.values()], lastKey: nextKey };
}
