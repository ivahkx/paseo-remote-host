import { t } from "../shared/text";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import type { AgentRecord, AgentStatus } from "../shared/model";
import { subtaskForest, flattenSubtasks } from "../shared/subtask-tree";
import { providerSubagentsRpc, providerTimelineRpc, type ProviderSubagent } from "../shared/provider-subagents";
import { nativeChildResult } from "../shared/native-results";
import { Banner, Button, EmptyState, IconButton, MetaLine, Row, SectionHeader, Segmented, Skeleton, fontSize, hairline, radius, relativeTime, space } from "./kit";
import { providerLine, readLabel, statusNames } from "./ui";
import { LiveTimer, PhaseLine, PhasePill, StatusGlyph, hueColor, phaseOf, type Phase } from "./status";
import { TimelineContent } from "./timeline-view";
import { ResultView } from "./result-view";
import { useForeground } from "./use-foreground";

const nativeStatus = (status: ProviderSubagent["status"]): AgentStatus => status === "failed" ? "error" : status;
/** Native children have no read state: a finished one is simply done. */
const nativePhase = (status: AgentStatus): Phase => status === "running" ? "running" : status === "initializing" ? "starting" : status === "error" ? "error" : status === "waiting" ? "approval"
  : status === "completed" ? "done" : status === "canceled" ? "canceled" : status === "closed" ? "closed" : status === "idle" ? "idle" : "quiet";
/** A managed child's state at the end of its row: a live timer while running, a pill when it needs you. */
function ChildState({ theme, agent }: { theme: PluginTheme; agent: AgentRecord }) {
  const phase = phaseOf(agent);
  if (phase === "running" && agent.activeTurnStartedAt) return <LiveTimer since={agent.activeTurnStartedAt} color={hueColor(theme, "run", "text")} />;
  if (phase === "approval") return <PhasePill theme={theme} hue="warn" label={t("secondarySubtasksView.waitingForApproval")} />;
  if (phase === "error") return <PhasePill theme={theme} hue="fail" label={t("secondarySubtasksView.error")} />;
  if (phase === "unread") return <PhasePill theme={theme} hue="ok" label={t("secondarySubtasksView.unread")} />;
  if (phase === "idle") return <PhasePill theme={theme} hue="violet" label={t("secondarySubtasksView.waitingForReply")} />;
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{statusNames[agent.status]}</Text>;
}

type SubtaskRow = { kind: "section"; id: string; label: string; count: number; action?: ReactNode } | { kind: "managed"; id: string; item: AgentRecord; depth: number };
export function SubtasksView({ agent, agents, theme, inset, onSelectAgent, header }: { agent: AgentRecord; agents: AgentRecord[]; theme: PluginTheme; inset: number; onSelectAgent: (id: string) => void; header?: ReactNode }) {
  // A provider's own native subagent list is read by a plugin running on the host itself, so a remote host cannot
  // answer it and this plugin has no server to ask. The managed tree below is built from the agent directory.
  const [collapsed] = useState<Set<string>>(new Set());
  const { colors } = theme;
  const managed = useMemo(() => { const byParent = new Map<string, AgentRecord[]>(); for (const item of agents) { if (!item.parentAgentId) continue; const bucket = byParent.get(item.parentAgentId) ?? []; bucket.push(item); byParent.set(item.parentAgentId, bucket); } const stack = (byParent.get(agent.id) ?? []).slice().reverse().map(item => ({ item, depth: 0 })); const seen = new Set([agent.id]), rows: Array<{ item: AgentRecord; depth: number }> = []; while (stack.length) { const entry = stack.pop()!; if (seen.has(entry.item.id)) continue; seen.add(entry.item.id); rows.push(entry); const children = byParent.get(entry.item.id) ?? []; for (let i = children.length - 1; i >= 0; i--) stack.push({ item: children[i]!, depth: entry.depth + 1 }); } return rows; }, [agent.id, agents]);
  const rows: SubtaskRow[] = [
    ...(managed.length ? [{ kind: "section" as const, id: "managed", label: t("secondarySubtasksView.paseoSubagents"), count: managed.length }, ...managed.map(row => ({ ...row, kind: "managed" as const, id: `managed:${row.item.id}` }))] : []),
  ];
  const indent = (depth: number) => depth ? { marginLeft: 16 + (Math.min(depth, 3) - 1) * 22, paddingLeft: 6, borderLeftWidth: hairline, borderLeftColor: colors.border } : undefined;
  return <FlatList data={rows} keyExtractor={row => row.id} style={{ flex: 1, minHeight: 0 }} initialNumToRender={12} windowSize={5} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl }}
    ListHeaderComponent={<View style={{ gap: space.md, paddingBottom: space.xs }}>{header}
      {agent.parentAgentId ? <View style={{ alignItems: "flex-start", marginLeft: -space.sm, marginTop: header ? 0 : space.md }}><Button theme={theme} label={t("secondarySubtasksView.viewParentAgent")} icon="CornerLeftUp" variant="ghost" size="sm" onPress={() => onSelectAgent(agent.parentAgentId!)} /></View> : null}
    </View>}
    renderItem={({ item: row }) => {
      if (row.kind === "section") return <View style={{ marginHorizontal: -space.md }}><SectionHeader theme={theme} title={row.label} count={row.count} action={row.action} /></View>;
      return <View style={[{ marginHorizontal: -space.md }, indent(row.depth)]}>
        <Row theme={theme} title={row.item.title} accessibilityLabel={t("secondarySubtasksView.viewSubagent", { value1: row.item.title })} onPress={() => onSelectAgent(row.item.id)}
          leading={<View accessibilityLabel={readLabel(row.item)}><StatusGlyph theme={theme} phase={phaseOf(row.item)} /></View>}
          trailing={<ChildState theme={theme} agent={row.item} />}
          subtitle={<MetaLine theme={theme} parts={[providerLine(row.item), relativeTime(row.item.lastActivityAt)]} />} />
      </View>;
    }}
    ListFooterComponent={managed.length ? null : <EmptyState theme={theme} icon="GitBranch" title={t("secondarySubtasksView.noSubtasks")} message={t("secondarySubtasksView.thisSessionHasNotCreatedAny")} />} />;
}
