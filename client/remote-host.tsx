// A read-only view of agents on any host this app is connected to. It borrows each host's own
// connection through getPaseoClient(), feeds the same agent directory the main dashboard uses, and
// renders Observatory's own SessionList so a remote host looks and behaves like the local one.
// Everything here is reconstructed client-side from that borrowed connection — no server install, no
// credentials: the Sessions tab is the live directory, Events subscribes to the host's lifecycle
// events (observeEvents), Tokens sums each loaded agent's reported usage, and Signals runs the shared
// decisionSignals over both. The server's full historical telemetry/token ledgers stay local-only.
import { t } from "../shared/text";
import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { getPaseoClient, useHosts, type PluginHostSummary } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { createAgentDirectory, type ObservatoryState } from "../shared/directory-store";
import { buildDashboardRows, groupDashboardRows, needsAttention } from "../shared/dashboard-model";
import { isUnreadCompletion, matchesAgentStatus } from "../shared/model";
import { Chip, ChipBar, SearchField, space } from "./kit";
import { StatusChip } from "./status";
import { threadAttention } from "../shared/attention";
import { decisionSignals } from "../shared/decision-signals";
import type { TelemetryEvent } from "../shared/telemetry";
import { SessionList, countRunningDescendants, groupTitles, type SessionItem } from "./session-list";
import { ActivityFeed } from "./activity-feed";
import { useRemoteEvents } from "./remote-observation";
import { RemoteTokens } from "./remote-tokens";
import { RemoteSignals } from "./remote-signals";
import { RemoteAgentDetail } from "./remote-agent-detail";
import { useRemoteListDigests } from "./remote-list-digest";
import { useClock } from "./ui";

type Theme = PluginScreenProps["theme"];

type RemoteTab = "sessions" | "events" | "tokens" | "signals";
/** The Sessions tab's quick scope, the subset of the dashboard's chips that a remote directory snapshot can answer. */
type RemoteScope = "all" | "attention" | "running" | "unread" | "idle";
// Getters, so a language change re-reads the labels on the next render (as the detail's tabs do).
const TABS: ReadonlyArray<{ id: RemoteTab; readonly label: string }> = [
  { id: "sessions", get label() { return t("coreDashboard.sessions2"); } },
  { id: "events", get label() { return t("coreDashboard.events"); } },
  { id: "tokens", get label() { return t("coreDashboard.tokens"); } },
  { id: "signals", get label() { return t("coreRemoteHost.signalsTab"); } },
];
// Never shown: `localized: true` makes eventLabel() render each row from its stable `type` (shared/telemetry.ts), and
// permission_resolved reads `permissionAllowed` (always set here) rather than this text. It only satisfies the schema.
const EVENT_LABEL: Record<TelemetryEvent["type"], string> = {
  created: "Created",
  turn_started: "Turn started",
  turn_completed: "Turn completed",
  turn_failed: "Turn failed",
  turn_canceled: "Turn canceled",
  permission_requested: "Awaiting approval",
  permission_resolved: "Approval resolved",
  archived: "Archived",
};

const IDLE_STATE: ObservatoryState = {
  agents: [],
  loading: false,
  error: null,
  lastSyncedAt: null,
  isRefreshing: false,
  truncated: false,
  live: false,
};
const LOADING_STATE: ObservatoryState = { ...IDLE_STATE, loading: true };

/** Runs the shared agent directory against one remote host and tracks its live snapshot. */
function useRemoteDirectory(serverId: string | null, online: boolean): ObservatoryState {
  const [state, setState] = useState<ObservatoryState>(IDLE_STATE);
  useEffect(() => {
    if (!serverId || !online) {
      setState(IDLE_STATE);
      return;
    }
    setState(LOADING_STATE);
    let api;
    try {
      api = getPaseoClient(serverId);
    } catch (error) {
      setState({ ...IDLE_STATE, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const directory = createAgentDirectory(
      {
        list: (options) => api.agents.list(options),
        observe: (options) => api.agents.list({ ...options, subscribe: {} }).then((result) => result.subscription),
      },
      { includeArchived: false },
    );
    const unsubscribe = directory.subscribe(() => setState(directory.getSnapshot()));
    directory.start(true);
    setState(directory.getSnapshot());
    return () => {
      unsubscribe();
      directory.stop();
    };
  }, [serverId, online]);
  return state;
}

export function RemoteHostScreen({ theme, layout, host, navigation }: PluginScreenProps) {
  const hosts = useHosts();
  // Other hosts first: the current host's agents already live in the main dashboard.
  const ordered = useMemo(() => {
    const others = hosts.filter((candidate) => candidate.serverId !== host.id);
    const current = hosts.filter((candidate) => candidate.serverId === host.id);
    return [...others, ...current];
  }, [hosts, host.id]);

  // Only hosts other than the one showing this screen: the current host's agents are the main dashboard.
  const otherHosts = useMemo(() => ordered.filter((candidate) => candidate.serverId !== host.id), [ordered, host.id]);
  const [selected, setSelected] = useState<string | null>(null);
  // Default to the first online remote host, re-picking when the set of hosts changes. Never fall back to
  // the current host: this screen is for remote hosts only, so with no remote host it stays unselected.
  useEffect(() => {
    if (selected && otherHosts.some((candidate) => candidate.serverId === selected)) return;
    const preferred = otherHosts.find((candidate) => candidate.status === "online") ?? otherHosts[0];
    setSelected(preferred ? preferred.serverId : null);
  }, [otherHosts, selected]);

  const selectedHost = ordered.find((candidate) => candidate.serverId === selected) ?? null;
  // Attempt the connection for any host that is not clearly offline: a reachable host may report
  // "idle"/"connecting" rather than "online", and getPaseoClient surfaces a real failure as state.error.
  const online = !!selectedHost && selectedHost.status !== "offline";
  const state = useRemoteDirectory(selected, online);
  const now = useClock(1000);

  const [tab, setTab] = useState<RemoteTab>("sessions");
  // An agent opened in-screen (its remote timeline); cleared when the host changes.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  useEffect(() => { setSelectedAgentId(null); }, [selected]);
  const remoteEvents = useRemoteEvents(selected, online);
  const agentTitleById = useMemo(() => new Map(state.agents.map((agent) => [agent.id, agent.title])), [state.agents]);
  const telemetryEvents = useMemo<TelemetryEvent[]>(
    () =>
      remoteEvents.map((event) => ({
        id: event.id,
        agentId: event.agentId,
        agentTitle: agentTitleById.get(event.agentId) ?? "",
        at: event.at,
        type: event.type,
        label: EVENT_LABEL[event.type],
        localized: true,
        ...(event.permissionAllowed !== undefined ? { permissionAllowed: event.permissionAllowed } : {}),
      })),
    [remoteEvents, agentTitleById],
  );
  const signals = useMemo(() => decisionSignals(state.agents, telemetryEvents, now), [state.agents, telemetryEvents, now]);
  // The row labels the local dashboard shows for these very signal kinds (client/dashboard.tsx).
  const signalLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const signal of signals) {
      if (signal.kind === "quiet") labels.set(signal.agentId, t("coreDashboard.noRecentUpdates"));
      else if (signal.kind === "repeated_failure") labels.set(signal.agentId, t("coreDashboard.failedTimes", { value1: signal.count }));
    }
    return labels;
  }, [signals]);

  // The Sessions tab's own search, quick scope and sort, mirroring the local dashboard's. Screen-local: nothing is persisted
  // for a remote host (saved views and snoozes live in the local plugin's preference store).
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<RemoteScope>("all");
  const [sort, setSort] = useState<"attention" | "recent">("attention");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const attentionOf = useMemo(() => (agent: Parameters<typeof needsAttention>[0]) => needsAttention(agent), []);
  const items = useMemo<SessionItem[]>(() => {
    const { rows } = buildDashboardRows(state.agents, {
      query,
      status: scope === "running" ? "running" : scope === "idle" ? "idle" : "all",
      view: "tree",
      sort,
      expanded,
      readFilter: scope === "unread" ? "unread" : "all",
      ...(scope === "attention" ? { focus: attentionOf } : {}),
    });
    const sections = groupDashboardRows(rows, attentionOf);
    const result: SessionItem[] = [];
    for (const section of sections) {
      result.push({ kind: "section", key: `section:${section.group}`, group: section.group, title: groupTitles[section.group], count: section.threads });
      for (const row of section.rows) {
        const thread = row.node.children.length ? threadAttention(row.node, attentionOf) : null;
        result.push({
          kind: "row",
          key: row.node.agent.id,
          row,
          childUnread: thread?.unread ?? 0,
          childAttention: thread?.count ?? 0,
          childPhase: thread?.phase ?? null,
          childRunning: row.node.children.length ? countRunningDescendants(row) : 0,
          snoozed: false,
        });
      }
    }
    return result;
  }, [state.agents, expanded, attentionOf, query, scope, sort]);

  // Counts are over the whole directory, as the dashboard's are: a chip says how many exist, not how many pass the search.
  const counts = useMemo(() => ({
    attention: state.agents.filter(agent => !agent.archivedAt && attentionOf(agent)).length,
    running: state.agents.filter(agent => matchesAgentStatus(agent, "running")).length,
    unread: state.agents.filter(isUnreadCompletion).length,
    idle: state.agents.filter(agent => matchesAgentStatus(agent, "idle")).length,
  }), [state.agents, attentionOf]);

  const pad = layout.compact ? 12 : 20;
  const serverId = selectedHost?.serverId ?? null;
  // The rows actually on screen, in the order they are drawn, so the bounded summary budget follows the reader: expand a
  // thread and its subagents are summarised too, instead of the budget being spent on rows nobody has opened.
  const visibleAgents = useMemo(() => items.flatMap((item) => (item.kind === "row" ? [item.row.node.agent] : [])), [items]);
  // A bounded per-row digest summary, read only while the Sessions list is the visible tab.
  const rowStats = useRemoteListDigests(serverId, visibleAgents, tab === "sessions" && !selectedAgentId);
  // What a collapsed thread cost, summed from the subagents' own reported usage. No history is folded for this: it comes
  // from the directory snapshot the list already holds, so it is there before any summary has been read.
  const childTokens = useMemo(() => {
    const totals = new Map<string, number>();
    for (const item of items) {
      if (item.kind !== "row" || !item.row.node.children.length) continue;
      let sum = 0;
      const stack = [...item.row.node.children];
      while (stack.length) {
        const child = stack.pop()!;
        sum += child.agent.usage.totalTokens ?? 0;
        stack.push(...child.children);
      }
      if (sum) totals.set(item.row.node.agent.id, sum);
    }
    return totals;
  }, [items]);
  const openAgent = (agentId: string) => {
    if (serverId) navigation?.openAgent?.({ agentId, serverId });
  };
  const selectedAgent = selectedAgentId ? state.agents.find((agent) => agent.id === selectedAgentId) ?? null : null;
  // One reconstructed stream for the whole screen: the Events tab renders it, the detail folds this agent's share into its
  // digest and its Diagnostics list. Events only accumulate while this screen is open.
  const agentEvents = useMemo(
    () => (selectedAgentId ? telemetryEvents.filter((event) => event.agentId === selectedAgentId) : []),
    [telemetryEvents, selectedAgentId],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <HostPicker theme={theme} pad={pad} hosts={ordered} selected={selected} onSelect={setSelected} currentHostId={host.id} />
      {!selectedHost || !serverId ? (
        <Centered
          theme={theme}
          pad={pad}
          text={
            otherHosts.length === 0
              ? t("coreRemoteHost.noRemoteHosts", { count: hosts.length, hosts: hosts.map((candidate) => `${candidate.label} (${candidate.status})`).join(", ") })
              : t("coreRemoteHost.selectHost")
          }
        />
      ) : !online ? (
        <Centered theme={theme} pad={pad} text={t("coreRemoteHost.hostOffline", { value1: selectedHost.label })} />
      ) : state.error ? (
        <Centered theme={theme} pad={pad} text={t("coreRemoteHost.hostError", { value1: selectedHost.label, value2: selectedHost.status, value3: state.error })} tone="danger" />
      ) : state.loading && state.agents.length === 0 ? (
        <Centered theme={theme} pad={pad} text={t("coreRemoteHost.loadingFromHost", { value1: selectedHost.label, value2: selectedHost.status })} />
      ) : selectedAgent ? (
        <RemoteAgentDetail
          theme={theme}
          layout={layout}
          host={host}
          serverId={serverId}
          agent={selectedAgent}
          agents={state.agents}
          events={agentEvents}
          navigation={navigation}
          onBack={() => setSelectedAgentId(null)}
          onSelectAgent={setSelectedAgentId}
        />
      ) : (
        <>
          <TabBar theme={theme} pad={pad} tab={tab} onSelect={setTab} />
          {tab === "sessions" ? (
            <>
            <SessionFilters theme={theme} pad={pad} compact={layout.compact} query={query} onQuery={setQuery}
              scope={scope} onScope={next => setScope(current => current === next ? "all" : next)} counts={counts}
              sort={sort} onSort={() => setSort(sort === "attention" ? "recent" : "attention")} />
            <SessionList
              items={items}
              theme={theme}
              compact={layout.compact}
              selectedId={null}
              expanded={expanded}
              now={now}
              signals={signalLabels}
              stats={rowStats}
              childTokens={childTokens}
              empty={
                <Centered
                  theme={theme}
                  pad={pad}
                  text={state.loading ? t("coreRemoteHost.loadingAgents") : t("coreRemoteHost.noAgentsYet")}
                />
              }
              onToggle={toggle}
              onSelect={setSelectedAgentId}
            />
            </>
          ) : tab === "events" ? (
            <ActivityFeed events={telemetryEvents} theme={theme} onSelect={openAgent} now={now} selectedId={null} agents={state.agents} swimlane={false} />
          ) : tab === "tokens" ? (
            <RemoteTokens agents={state.agents} theme={theme} compact={layout.compact} />
          ) : (
            <RemoteSignals signals={signals} theme={theme} compact={layout.compact} now={now} onSelect={openAgent} />
          )}
        </>
      )}
    </View>
  );
}

/**
 * The Sessions tab's search and quick scopes, mirroring the local dashboard's chip bar (client/dashboard.tsx) with the
 * subset a remote directory snapshot can answer. Project and time-range pickers, the Filters sheet, saved views and the
 * snoozed chip are deliberately absent: those read the local plugin's preference store, which holds nothing for a remote host.
 */
function SessionFilters({ theme, pad, compact, query, onQuery, scope, onScope, counts, sort, onSort }: {
  theme: Theme; pad: number; compact: boolean; query: string; onQuery: (value: string) => void;
  scope: RemoteScope; onScope: (scope: RemoteScope) => void; counts: { attention: number; running: number; unread: number; idle: number };
  sort: "attention" | "recent"; onSort: () => void;
}) {
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ paddingHorizontal: pad, paddingTop: space.sm }}>
        <SearchField theme={theme} value={query} onChangeText={onQuery} placeholder={t("coreDashboard.searchTasksProjectsOrBranches")}
          accessibilityLabel={t("coreDashboard.searchSessions")} grow={!compact} />
      </View>
      <ChipBar>
        <StatusChip theme={theme} label={t("coreDashboard.needsAttention")} count={counts.attention} hue="warn"
          selected={scope === "attention"} onPress={() => onScope("attention")} />
        <StatusChip theme={theme} label={t("coreDashboard.running")} count={counts.running} hue="run" motion="spin"
          selected={scope === "running"} onPress={() => onScope("running")} />
        <StatusChip theme={theme} label={t("coreDashboard.unread")} count={counts.unread} hue="pink"
          selected={scope === "unread"} onPress={() => onScope("unread")} />
        <StatusChip theme={theme} label={t("coreDashboard.awaitingReply")} count={counts.idle} hue="violet"
          selected={scope === "idle"} onPress={() => onScope("idle")} />
        {/* The same toggle the local dashboard offers in its menu: the label names the order it switches to. */}
        <Chip theme={theme} icon="ArrowDownWideNarrow" label={sort === "attention" ? t("coreDashboard.sortByRecentActivity") : t("coreDashboard.sortByAttentionNeeded")}
          selected={sort === "recent"} onPress={onSort} />
      </ChipBar>
    </View>
  );
}

function TabBar({ theme, pad, tab, onSelect }: { theme: Theme; pad: number; tab: RemoteTab; onSelect: (tab: RemoteTab) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: pad, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      {TABS.map((entry) => {
        const active = entry.id === tab;
        return (
          <Pressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityLabel={t("coreRemoteHost.showTab", { value1: entry.label })}
            onPress={() => onSelect(entry.id)}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: active ? theme.colors.accent : theme.colors.surface1, borderWidth: 1, borderColor: active ? theme.colors.accent : theme.colors.border }}
          >
            <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13, fontWeight: active ? "600" : "400" }}>{entry.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function HostPicker({
  theme,
  pad,
  hosts,
  selected,
  onSelect,
  currentHostId,
}: {
  theme: Theme;
  pad: number;
  hosts: readonly PluginHostSummary[];
  selected: string | null;
  onSelect: (serverId: string) => void;
  currentHostId: string;
}) {
  if (hosts.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: pad, paddingVertical: 10, gap: 8 }}
      style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border, flexGrow: 0 }}
    >
      {hosts.map((candidate) => {
        const active = candidate.serverId === selected;
        const isCurrent = candidate.serverId === currentHostId;
        const dot =
          candidate.status === "online"
            ? theme.colors.statusSuccess
            : candidate.status === "error"
              ? theme.colors.statusDanger
              : theme.colors.foregroundMuted;
        return (
          <Pressable
            key={candidate.serverId}
            accessibilityRole="button"
            accessibilityLabel={t("coreRemoteHost.showAgentsOn", { value1: candidate.label })}
            onPress={() => onSelect(candidate.serverId)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: active ? theme.colors.accent : theme.colors.border,
              backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
            }}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
            <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>
              {candidate.label}
              {isCurrent ? t("coreRemoteHost.thisHost") : ""}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Centered({
  theme,
  pad,
  text,
  tone,
  children,
}: {
  theme: Theme;
  pad: number;
  text?: string;
  tone?: "danger";
  children?: ReactNode;
}) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: pad * 2, gap: 10 }}>
      {children}
      {text ? (
        <Text style={{ color: tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 14, textAlign: "center" }}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

export function RemoteHostSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Satellite"
      active={currentScreen?.screenId === "remote-host"}
      onPress={() => openScreen({ screenId: "remote-host" })}
    />
  );
}
