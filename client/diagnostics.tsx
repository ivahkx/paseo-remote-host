// The Diagnostics section of a session detail, copied from Agent Observatory's client/agent-detail.tsx so this plugin
// does not depend on that file (which also pulls in insights, schedules, quick replies and the permission panel).
// Behaviour is unchanged, including the honest "—" it shows for every observation field when `observed` is absent: that
// telemetry is recorded by a plugin running on the host itself, and this plugin never has it for a remote agent.
import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { formatTokens, type AgentRecord } from "../shared/model";
import { eventLabel, type TelemetrySnapshot } from "../shared/telemetry";
import { Banner, MetaLine, Skeleton, fontSize, formatDuration, relativeTime, space } from "./kit";
import { InfoButton, KeyValue, PaneLabel, StatRow, checkoutName, useClock } from "./ui";
import { EventGlyph } from "./status";
import { CodeBlock } from "./timeline-view";

const localTime = (value: string | null) => value ? new Date(value).toLocaleString(currentLanguage(), { hour12: false }) : t("coreAgentDetail.notReported");

const sectionLooks: Record<string, { label: string; icon: string; tone: "blue" | "violet" | "orange" | "teal" }> = {
  context: { get label() { return t("coreAgentDetail.executionContext"); }, icon: "FolderGit2", tone: "blue" }, history: { get label() { return t("coreAgentDetail.sessionHistory"); }, icon: "History", tone: "violet" }, usage: { get label() { return t("coreAgentDetail.usage"); }, icon: "Gauge", tone: "orange" }, observation: { get label() { return t("coreAgentDetail.pluginObservations"); }, icon: "Eye", tone: "teal" }, lifecycle: { get label() { return t("coreAgentDetail.lifecycleEvents"); }, icon: "Activity", tone: "orange" },
};
/** Exported so the remote-host detail renders the same section; it already shows "—" wherever `observed` is absent. */
export function Diagnostics({ theme, agent, compact, observed, activity, evidence, evidenceLoading, evidenceError }: {
  theme: PluginTheme; agent: AgentRecord; compact: boolean; observed?: TelemetrySnapshot["agents"][number]; activity: TelemetrySnapshot["events"];
  evidence?: { turns: number; tools: number; toolFailures: number; complete: boolean; coverageReason: string | null }; evidenceLoading: boolean; evidenceError: boolean;
}) {
  const now = useClock(30_000);
  const usage = agent.usage;
  const section = (id: string, children: ReactNode, info?: readonly string[]) => { const title = sectionLooks[id]!.label; return <View style={{ gap: space.xs }}>
    <PaneLabel theme={theme} icon={sectionLooks[id]?.icon} tone={sectionLooks[id]?.tone} trailing={info ? <InfoButton theme={theme} title={t("coreAgentDetail.about", { value1: title })} lines={info} /> : undefined}>{title}</PaneLabel>
    {children}
  </View>; };
  return <View style={{ gap: space.xl }}>
    {agent.lastError ? <Banner theme={theme} tone="danger" message={agent.lastError} /> : null}
    {section("context", <View>
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.project")} value={agent.projectName} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.projectRoot")} value={agent.projectRootPath || t("coreAgentDetail.notReported")} mono />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.workspace")} value={agent.workspaceName || agent.workspaceId || t("coreAgentDetail.noWorkspaceAssigned")} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.checkoutType")} value={agent.checkoutKind === "worktree" ? t("coreAgentDetail.separateWorktree") : checkoutName(agent)} />
      {agent.checkoutKind === "worktree" ? <><KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.worktreeName")} value={agent.worktreeName || t("coreAgentDetail.notReported")} /><KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.worktreePath")} value={agent.worktreePath || t("coreAgentDetail.notReported")} mono /></> : null}
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.branch")} value={agent.branch || t("coreAgentDetail.notReportedDetachedHead")} mono={!!agent.branch} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.agentWorkingDirectory")} value={agent.cwd || t("coreAgentDetail.notReported")} mono />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.agentId")} value={agent.id} mono />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.rawRuntimeStatus")} value={agent.rawStatus} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.created")} value={localTime(agent.createdAt)} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.lastActive")} value={localTime(agent.lastActivityAt)} />
      {agent.parentAgentId ? <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.parentAgent")} value={agent.parentAgentId} mono /> : null}
    </View>)}
    {section("history", evidenceLoading ? <Skeleton theme={theme} rows={1} /> : evidenceError ? <MetaLine theme={theme} parts={[t("coreAgentDetail.historyEvidenceIsTemporarilyUnavailableSwitchingTabs")]} /> : evidence ? <View style={{ gap: space.sm }}>
      <StatRow theme={theme} stats={[{ label: t("coreAgentDetail.userTurns"), value: String(evidence.turns) }, { label: t("coreAgentDetail.toolRuns"), value: String(evidence.tools) }, { label: t("coreAgentDetail.toolFailures"), value: String(evidence.toolFailures), tone: evidence.toolFailures ? "danger" : undefined }]} />
      <MetaLine theme={theme} numberOfLines={2} parts={[evidence.complete ? t("coreAgentDetail.coversTheFullHistoryKeptByPaseo") : evidence.coverageReason || t("coreAgentDetail.coversOnlyPartOfTheHistory")]} />
    </View> : null)}
    {section("usage", <View style={{ gap: space.sm }}>
      <StatRow theme={theme} stats={[{ label: t("coreAgentDetail.inputTokens"), value: formatTokens(usage.inputTokens) }, { label: t("coreAgentDetail.outputTokens"), value: formatTokens(usage.outputTokens) }, { label: t("coreAgentDetail.cacheHits"), value: formatTokens(usage.cachedInputTokens) }, { label: t("coreAgentDetail.apiEquivalentCost"), value: usage.costUsd === null ? "—" : `$${usage.costUsd.toFixed(4)}` }]} />
      {usage.contextTotal !== null ? <MetaLine theme={theme} parts={[t("coreAgentDetail.context", { value1: formatTokens(usage.contextUsed), value2: formatTokens(usage.contextTotal) })]} /> : null}
    </View>, [t("coreAgentDetail.showsOnlyTheProviderSLatestReported"), t("coreAgentDetail.unreportedMetricsShowAsNot0"), t("coreAgentDetail.apiEquivalentCostIsTheAgentS")])}
    {section("observation", <StatRow theme={theme} stats={[{ label: t("coreAgentDetail.completedTurns"), value: observed ? String(observed.completedTurns) : "—" }, { label: t("coreAgentDetail.failedTurns"), value: observed ? String(observed.failedTurns) : "—", tone: observed?.failedTurns ? "danger" : undefined }, { label: t("coreAgentDetail.totalRuntime2"), value: observed ? formatDuration(observed.totalRunMs) || t("coreAgentDetail.value0Seconds") : "—" }, { label: t("coreAgentDetail.waitingForApproval"), value: observed ? formatDuration(observed.permissionWaitMs) || t("coreAgentDetail.value0Seconds") : "—" }]} />,
      [t("coreAgentDetail.countsFromWhenThePluginBeganObserving")])}
    {activity.length ? section("lifecycle", <View>{activity.map(event => <View key={event.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
      <EventGlyph theme={theme} type={event.type} size={14} />
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small }}>{eventLabel(event)}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{relativeTime(event.at, now)}</Text>
    </View>)}</View>) : null}
    {Object.keys(agent.labels).length ? <CodeBlock theme={theme} label={t("coreAgentDetail.agentLabels")} value={agent.labels} /> : null}
  </View>;
}
