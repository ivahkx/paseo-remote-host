// A remote host's agent detail, mirroring Observatory's own AgentDetail (client/agent-detail.tsx): the same six-tab shell
// (Result · Recap · Timeline · Subtasks · Diagnostics · Analysis), driven entirely from the borrowed remote connection.
// Result, Recap (the 复盘 digest) and Timeline all run the plugin's own builders client-side over that connection, and
// Subtasks renders the managed tree from the remote directory snapshot. Diagnostics and Analysis depend on evidence only
// the local plugin server records, so they show on-brand empty states. The AI recap card in the header is the one thing
// This plugin has no server side at all: everything here is read over the borrowed connection.
import { t } from "../shared/text";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { formatTokens, type AgentRecord } from "../shared/model";
import { fetchAgentResult } from "../shared/result-build";
import { normalizeTimelinePage } from "../shared/timeline";
import type { DigestTurn } from "../shared/digest";
import type { TelemetrySnapshot } from "../shared/telemetry";
import { Button, EmptyState, IconButton, MetaLine, Spacer, Tabs, Toolbar, fontSize, hairline, hue, radius, relativeTime, space } from "./kit";
import { IdentityLine, checkoutName, providerLine } from "./ui";
import { PhaseLine, hueColor, tint } from "./status";
import { Sweep } from "./motion";
import { AgentDigest } from "./agent-digest";
import { Diagnostics } from "./diagnostics";
import { useRemoteEvidence } from "./remote-evidence";
import { useRemoteDigest } from "./remote-digest";
import { ResultView } from "./result-view";
import { SubtasksView } from "./subtasks-view";
import { TimelineContent } from "./timeline-view";
import { useRemoteTimeline } from "./remote-timeline";


// The same tab set, labels, icons and tones as the local AgentDetail (client/agent-detail.tsx).
const TAB_DEFS = [
  { value: "result", get label() { return t("coreAgentDetail.result"); }, icon: "FileCheck", tone: "green" },
  { value: "digest", get label() { return t("coreAgentDetail.recap"); }, icon: "ChartGantt", tone: "fuchsia" },
  { value: "timeline", get label() { return t("coreAgentDetail.timeline"); }, icon: "ListTree", tone: "blue" },
  { value: "children", get label() { return t("coreAgentDetail.subtasks"); }, icon: "Workflow", tone: "violet" },
  { value: "diagnostics", get label() { return t("coreAgentDetail.diagnostics"); }, icon: "Stethoscope", tone: "orange" },
  { value: "insights", get label() { return t("coreAgentDetail.analysis"); }, icon: "Sparkles", tone: "pink" },
] as const;
type RemoteTab = typeof TAB_DEFS[number]["value"];

/** The timeline's own words for how a turn ended, so this list and the Execution timeline agree. */
const OUTCOME_LABEL: Record<DigestTurn["outcome"], string> = {
  get completed() { return t("coreAgentDigest.completed"); },
  get failed() { return t("coreAgentDigest.failed"); },
  get canceled() { return t("coreAgentDigest.interrupted"); },
  get running() { return t("coreAgentDigest.inProgress"); },
  get unknown() { return t("coreAgentDigest.ended"); },
};
const OUTCOME_HUE: Record<DigestTurn["outcome"], "green" | "red" | "gray" | "blue"> = {
  completed: "green", failed: "red", canceled: "gray", running: "blue", unknown: "gray",
};

/**
 * What the user actually typed, one entry per turn. The list is driven by the digest's turns, which are folded from the
 * whole history, so every turn is numbered even when the Timeline tab has only loaded the tail. The full prompt text lives
 * only on the timeline row (the fold truncates it to 242 characters, and `digestTurn.prompt` to 200), so a turn whose row
 * is not loaded shows the digest excerpt and is labelled as one — a truncated prompt is never passed off as complete.
 */
function UserPrompts({ theme, timeline, turns, pending, agentId, now, onOpen }: {
  theme: PluginTheme; timeline: ReturnType<typeof useRemoteTimeline>; turns: readonly DigestTurn[]; pending: boolean;
  agentId: string; now: number; onOpen: (ref: string) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);

  // Join each turn to its prompt row: by turnId when the host supplies one, else by the row falling inside the turn's
  // window. `foldRows` opens a turn on every user_message, so a turn's start is that prompt's own timestamp (±clock skew).
  const loaded = (timeline.page?.rows ?? []).filter(row => row.item.type === "user_message" && typeof row.item.text === "string" && row.item.text.trim());
  const byTurnId = new Map(loaded.filter(row => row.turnId).map(row => [row.turnId!, row]));
  const entries = turns.map(turn => {
    const row = (turn.turnId ? byTurnId.get(turn.turnId) : undefined)
      ?? loaded.find(candidate => { const at = Date.parse(candidate.timestamp); return Number.isFinite(at) && at >= turn.start - 1000 && at <= (turn.end ?? turn.start) + 1000; });
    const full = row ? String(row.item.text).trim() : "";
    return { turn, row, text: full || turn.prompt, excerpt: !full && !!turn.prompt };
  }).filter(entry => entry.text);
  const excerpts = entries.filter(entry => entry.excerpt).length;

  const copyAll = () => {
    // Each prompt under its turn marker, in execution order; an excerpt is never copied as if it were the whole prompt.
    const body = entries.map(entry => `#${entry.turn.index}\n${entry.text}`).join("\n\n");
    void copyText(body)
      .then(() => toast.show(excerpts ? t("coreRemoteHost.promptsCopiedPartial", { count: entries.length }) : t("coreRemoteHost.promptsCopied", { count: entries.length }), { variant: "success" }))
      .catch(() => toast.error(t("coreRemoteHost.copyFailed")));
  };

  return (
    <View style={{ borderBottomWidth: hairline, borderBottomColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={t("coreRemoteHost.promptsTitle")}
          onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flex: 1, minWidth: 0 }}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
          <Icon name="MessageSquareText" size={14} color={theme.colors.accent} />
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{t("coreRemoteHost.promptsTitle")}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreRemoteHost.promptsCount", { count: entries.length })}</Text>
        </Pressable>
        {entries.length ? <Button theme={theme} size="sm" variant="ghost" icon="Copy" label={t("coreRemoteHost.copyAll")} onPress={copyAll} /> : null}
      </View>
      {open ? (
        <View style={{ paddingBottom: space.sm, gap: space.xs }}>
          {/* Stated, not implied: the list covers every turn, but some entries may only carry the digest's excerpt. */}
          {excerpts ? <MetaLine theme={theme} numberOfLines={2} parts={[t("coreRemoteHost.promptsPartial")]} /> : null}
          {entries.length ? entries.map(entry => {
            const jump = entry.row ? () => onOpen(`${agentId}:${entry.row!.epoch}:${entry.row!.seqStart}-${entry.row!.seqEnd}`) : undefined;
            const head = (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <Text style={{ color: hue(theme, OUTCOME_HUE[entry.turn.outcome], "text"), fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] }}>#{entry.turn.index}</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{OUTCOME_LABEL[entry.turn.outcome]}</Text>
                <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{relativeTime(entry.row?.timestamp ?? new Date(entry.turn.start).toISOString(), now)}</Text>
                {entry.excerpt ? <Text style={{ color: hue(theme, "amber", "text"), fontSize: 11 }}>{t("coreRemoteHost.promptExcerpt")}</Text> : null}
              </View>
            );
            const body = <Text numberOfLines={3} style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 18 }}>{entry.text}</Text>;
            const style = { gap: 2, paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.md, borderWidth: hairline, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 } as const;
            // Only a loaded row can be jumped to; an excerpt-only turn is plain text rather than a tap that does nothing.
            return jump
              ? <Pressable key={entry.turn.index} accessibilityRole="button" accessibilityLabel={entry.text.slice(0, 80)} onPress={jump} style={style}>{head}{body}</Pressable>
              : <View key={entry.turn.index} style={style}>{head}{body}</View>;
          }) : <MetaLine theme={theme} parts={[pending ? t("coreRemoteHost.loadingConversation") : t("coreRemoteHost.promptsEmpty")]} />}
        </View>
      ) : null}
    </View>
  );
}

function RemoteEmpty({ theme, icon, title, message, inset, header }: { theme: PluginTheme; icon: string; title: string; message: string; inset: number; header?: ReactNode }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl }}>
      {header}
      <EmptyState theme={theme} icon={icon} title={title} message={message} tone="neutral" />
    </ScrollView>
  );
}

export function RemoteAgentDetail({ theme, layout, serverId, agent, agents, events, navigation, onBack, onSelectAgent }: {
  theme: PluginTheme;
  layout: PluginScreenProps["layout"];
  serverId: string;
  agent: AgentRecord;
  agents: AgentRecord[];
  /**
   * This agent's reconstructed lifecycle events, from the one stream the screen already runs (client/remote-observation.ts).
   * They feed both the digest's turn outcomes and approval wait and the Diagnostics lifecycle list, so nothing subscribes twice.
   */
  events: TelemetrySnapshot["events"];
  navigation?: PluginScreenProps["navigation"];
  onBack: () => void;
  onSelectAgent: (id: string) => void;
}) {
  const { colors } = theme;
  const compact = layout.compact;
  const inset = compact ? space.lg : space.xl;
  // Recap first: it is the tab that answers "how did this agent do". The timeline hook stays enabled for it too, so
  // selecting Timeline afterwards is instant and the recap button still has a conversation tail to send.
  const [tab, setTab] = useState<RemoteTab>("digest");
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const openEvidence = (ref: string) => { setFocusRef(ref); setTab("timeline"); };
  // The timeline is read while on the Timeline tab and also while on Recap (the AI recap sends the conversation).
  const timeline = useRemoteTimeline(serverId, agent.id, tab === "timeline" || tab === "digest");
  // Also read on the Timeline tab: its prompt list is driven by the digest's turns. The folded history is shared and
  // cached (client/remote-history-cache.ts), so this costs nothing beyond the first read of this agent.
  const digest = useRemoteDigest(serverId, agent, events, tab === "digest" || tab === "timeline");
  const evidence = useRemoteEvidence(serverId, agent.id, tab === "diagnostics");
  // The same reader the local Result tab uses (shared/result-build.ts), run against the remote daemon's own API. No
  // telemetry is passed: that is the local plugin server's observation and does not exist for a remote host.
  const result = useQuery({
    queryKey: ["remote-result", serverId, agent.id],
    queryFn: () => fetchAgentResult(getPaseoClient(serverId), agent.id, null),
    enabled: tab === "result",
    staleTime: 2000,
    retry: 1,
  });
  const openInApp = navigation?.openAgent ? () => void navigation.openAgent?.({ agentId: agent.id, serverId }) : undefined;

  const header = (
    <View style={{ gap: space.sm, paddingTop: compact ? space.lg : 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 26 }}>
        <PhaseLine theme={theme} agent={agent} />
        {!compact ? <><Spacer /><IconButton theme={theme} icon="ChevronLeft" label={t("coreRemoteHost.backToSessions")} size="sm" onPress={onBack} /></> : null}
      </View>
      <Text selectable numberOfLines={compact ? undefined : 3} style={{ color: colors.foreground, fontSize: fontSize.heading, fontWeight: "600", lineHeight: 26 }}>{agent.title || agent.id}</Text>
      <IdentityLine theme={theme} agent={agent} compact={compact} />
      {/* The status is the PhaseLine's job above, already localized; repeating `agent.status` here would print the raw value. */}
      <MetaLine theme={theme} numberOfLines={2} parts={[providerLine(agent), checkoutName(agent), agent.branch]} />
      <MetaLine theme={theme} parts={[
        agent.usage.inputTokens !== null ? t("coreRemoteHost.tokensIn", { value1: formatTokens(agent.usage.inputTokens) }) : null,
        agent.usage.outputTokens !== null ? t("coreRemoteHost.tokensOut", { value1: formatTokens(agent.usage.outputTokens) }) : null,
        agent.usage.totalTokens !== null ? t("coreRemoteHost.tokensTotalOf", { value1: formatTokens(agent.usage.totalTokens) }) : null,
      ]} />
      {openInApp ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingTop: space.xs }}>
        <Button theme={theme} label={t("coreAgentDetail.openSession")} icon="ArrowUpRight" variant="primary" onPress={openInApp} />
      </View> : null}
    </View>
  );

  const tabBar = compact
    ? <ScrollView horizontal showsHorizontalScrollIndicator={false}><Tabs theme={theme} value={tab} onChange={setTab} options={TAB_DEFS.map(({ icon: _icon, ...option }) => option)} /></ScrollView>
    : <Tabs theme={theme} value={tab} onChange={setTab} options={TAB_DEFS} />;
  // On phones header + tab bar scroll with the content; on wide layouts they stay pinned and the body omits them.
  const scrolled = compact ? <View style={{ gap: space.md }}>{header}{tabBar}</View> : undefined;

  const body = tab === "result" ? (
    <ResultView theme={theme} agent={agent} data={result.data} loading={result.isPending} error={result.error ? result.error.message : undefined}
      header={scrolled} inset={inset} compact={compact} onOpenEvidence={openEvidence} onRefresh={() => void result.refetch()} />
  ) : tab === "digest" ? (
    <AgentDigest theme={theme} compact={compact} digest={digest.data} loading={digest.isPending} error={digest.error?.message}
      onRefresh={() => void digest.refetch()} onOpenSeq={(epoch, seq) => openEvidence(`${agent.id}:${epoch}:${seq}-${seq}`)} header={scrolled} inset={inset} />
  ) : tab === "timeline" ? (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ paddingHorizontal: inset }}>
        <UserPrompts theme={theme} timeline={timeline} turns={digest.data?.turns ?? []} pending={digest.isPending} agentId={agent.id} now={Date.now()} onOpen={openEvidence} />
      </View>
      <TimelineContent timeline={timeline} theme={theme} cacheKey={`remote:${serverId}:${agent.id}`} focusRef={focusRef} header={scrolled} inset={inset} />
    </View>
  ) : tab === "children" ? (
    <SubtasksView agent={agent} agents={agents} theme={theme} inset={inset} onSelectAgent={onSelectAgent} header={scrolled} />
  ) : tab === "diagnostics" ? (
    // The same section the local detail renders. `observed` is the plugin server's own telemetry, which does not exist for
    // a remote host, so every observation field honestly reads "—" rather than a fabricated number.
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl, gap: space.lg }}>
      {scrolled}
      <View style={{ paddingTop: compact ? 0 : space.lg }}>
        {/* The newest observed events, as agent-detail slices its own telemetry for this list. */}
        <Diagnostics theme={theme} agent={agent} compact={compact} observed={undefined} activity={events.slice(0, 20)}
          evidence={evidence.data} evidenceLoading={evidence.isPending} evidenceError={!!evidence.error} />
      </View>
    </ScrollView>
  ) : (
    <RemoteEmpty theme={theme} icon="Sparkles" title={t("coreRemoteHost.analysisTitle")}
      message={t("coreRemoteHost.analysisMessage")} inset={inset} header={scrolled} />
  );

  const blue = hueColor(theme, "run");
  const sweep = agent.status === "running" && !agent.archivedAt ? <Sweep color={blue} track={tint(blue, 0.14)} /> : <View style={{ height: 2 }} />;

  if (!compact) return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {sweep}
      <View style={{ paddingHorizontal: inset, paddingTop: space.lg - 2, gap: space.md }}>{header}{tabBar}</View>
      {body}
    </View>
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <Toolbar theme={theme}>
        <IconButton theme={theme} icon="ChevronLeft" label={t("coreRemoteHost.backToSessions")} onPress={onBack} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{t("coreAgentDetail.sessionDetails")}</Text>
      </Toolbar>
      {agent.status === "running" && !agent.archivedAt ? sweep : null}
      {body}
    </View>
  );
}
