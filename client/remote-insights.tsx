// The Analysis tab of a remote session. Agent Observatory's own Analysis page is a queue of jobs its server owns; this
// plugin has no server, so there is no queue, no stored history and no automatic trigger: one run at a time, started by
// the user, kept in the screen's state until the session or the host changes. What it reads comes from the observed
// host over the borrowed connection; what writes the report is a temporary session on the host this screen is on
// (client/remote-insight-run.ts), so the machine being analysed is only ever read.
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { formatTokens, type AgentRecord } from "../shared/model";
import type { InsightEvidence, InsightReport } from "../shared/insights";
import type { ResultApi } from "../shared/result-build";
import { useAnalyst, useRemoteInsight, type RemoteInsightRun } from "./remote-insight-run";
import { Badge, Banner, Button, EmptyState, MetaLine, StatusDot, fontSize, hairline, radius, relativeTime, space, toneColor, type Tone } from "./kit";
import { PaneLabel, monoFont } from "./ui";

type Severity = InsightReport["findings"][number]["severity"];
type Category = InsightReport["findings"][number]["category"];
// Getters throughout, so a language change re-reads the labels on the next render (as the detail's tabs do).
const healthNames: Record<InsightReport["health"], string> = {
  get healthy() { return t("coreRemoteInsights.healthy"); },
  get watch() { return t("coreRemoteInsights.watch"); },
  get blocked() { return t("coreRemoteInsights.blocked"); },
};
const healthTones: Record<InsightReport["health"], Tone> = { healthy: "success", watch: "warning", blocked: "danger" };
const confidenceNames: Record<InsightReport["confidence"], string> = {
  get high() { return t("coreRemoteInsights.high"); },
  get medium() { return t("coreRemoteInsights.medium"); },
  get low() { return t("coreRemoteInsights.low"); },
};
const severityNames: Record<Severity, string> = {
  get high() { return t("coreRemoteInsights.highPriority"); },
  get medium() { return t("coreRemoteInsights.mediumPriority"); },
  get low() { return t("coreRemoteInsights.lowPriority"); },
};
const severityTones: Record<Severity, Tone> = { high: "danger", medium: "warning", low: "neutral" };
const categoryNames: Record<Category, string> = {
  get failure() { return t("coreRemoteInsights.failure"); },
  get loop() { return t("coreRemoteInsights.loop"); },
  get efficiency() { return t("coreRemoteInsights.efficiency"); },
  get coordination() { return t("coreRemoteInsights.coordination"); },
  get quality() { return t("coreRemoteInsights.quality"); },
};
const evidenceKinds: Record<string, string> = {
  get tool_call() { return t("coreRemoteInsights.toolCall"); },
  get assistant_message() { return t("coreRemoteInsights.agentReply"); },
  get user_message() { return t("coreRemoteInsights.userInstruction"); },
  get reasoning() { return t("coreRemoteInsights.reasoningSummary"); },
  get error() { return t("coreRemoteInsights.executionError"); },
  get notification() { return t("coreRemoteInsights.executionNotice"); },
  get todo() { return t("coreRemoteInsights.taskPlan"); },
  get compaction() { return t("coreRemoteInsights.contextCompaction"); },
  get plugin() { return t("coreRemoteInsights.pluginRecord"); },
};

/** The two stages a run moves through, as a bar: reading the other host, then waiting on the model here. */
function Progress({ theme, run, host }: { theme: PluginTheme; run: RemoteInsightRun; host: string }) {
  const { colors } = theme;
  const steps = [
    { stage: "reading" as const, label: t("coreRemoteInsights.stageReading") },
    { stage: "analyzing" as const, label: t("coreRemoteInsights.stageAnalyzing", { host }) },
  ];
  const activeIndex = steps.findIndex(step => step.stage === run.stage);
  const mark = toneColor(theme, "accent", "mark");
  return <View style={{ gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: hairline, borderColor: colors.border, backgroundColor: colors.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <ActivityIndicator size="small" color={colors.foregroundMuted} />
      <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{steps[Math.max(0, activeIndex)].label}</Text>
      <Button theme={theme} label={t("coreRemoteInsights.cancel")} size="sm" onPress={run.cancel} />
    </View>
    <View style={{ flexDirection: "row", gap: space.xs }}>{steps.map((step, index) => <View key={step.stage} style={{ flex: 1, gap: space.xs }}>
      <View style={{ height: 3, borderRadius: 2, backgroundColor: index <= activeIndex ? mark : colors.surface2 }} />
      <Text style={{ color: index === activeIndex ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.meta }}>{step.label}</Text>
    </View>)}</View>
    <MetaLine theme={theme} numberOfLines={2} parts={[
      run.coverage ? t("coreRemoteInsights.readRows", { count: run.coverage.rows }) : null,
      run.coverage?.truncated ? t("coreRemoteInsights.limitedWindow") : null,
    ]} />
  </View>;
}

function EvidenceSnippet({ theme, reference, source, onOpen }: { theme: PluginTheme; reference: string; source?: InsightEvidence; onOpen?: () => void }) {
  const { colors } = theme;
  const [expanded, setExpanded] = useState(false);
  const label = source ? source.toolName || evidenceKinds[source.kind] || source.kind || t("coreRemoteInsights.executionTrace") : t("coreRemoteInsights.excerptMissing");
  const date = source?.at ? new Date(source.at) : null;
  const recordedAt = date && Number.isFinite(date.getTime())
    ? date.toLocaleString(currentLanguage(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : t("coreRemoteInsights.timeNotRecorded");
  const expandable = !!source && (source.text.length > 280 || source.text.split("\n").length > 4);
  const toggle = expanded ? t("coreRemoteInsights.collapse") : t("coreRemoteInsights.expand");
  return <View style={{ borderRadius: radius.md, borderWidth: hairline, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>
    <Pressable disabled={!expandable} accessibilityRole={expandable ? "button" : undefined} accessibilityState={expandable ? { expanded } : undefined}
      accessibilityLabel={expandable ? t("coreRemoteInsights.evidenceExcerpt", { value1: toggle, value2: label }) : undefined} onPress={() => setExpanded(!expanded)}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36, paddingHorizontal: 10, paddingVertical: space.xs + 2 }}>
      <Icon name={source?.toolName ? "Terminal" : source ? "FileText" : "FileQuestion"} size={14} color={colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "500", fontFamily: source?.toolName ? monoFont : undefined }}>{label}</Text>
      {source ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{recordedAt}</Text> : null}
      {expandable ? <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={12} color={colors.foregroundMuted} /> : null}
    </Pressable>
    {source
      ? <Text selectable numberOfLines={expanded || !expandable ? undefined : 5} style={{ paddingHorizontal: 10, paddingBottom: space.sm, color: colors.foreground, fontSize: fontSize.meta, lineHeight: 18, ...(source.toolName ? { fontFamily: monoFont } : {}) }}>{source.text || t("coreRemoteInsights.noText")}</Text>
      : <Text style={{ paddingHorizontal: 10, paddingBottom: space.sm, color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("coreRemoteInsights.excerptMissing")}</Text>}
    {expandable ? <Pressable accessibilityRole="button" accessibilityLabel={t("coreRemoteInsights.evidenceExcerpt", { value1: toggle, value2: label })} onPress={() => setExpanded(!expanded)}
      style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{expanded ? t("coreRemoteInsights.collapseExcerpt") : t("coreRemoteInsights.expandExcerpt")}</Text>
    </Pressable> : null}
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32, paddingLeft: 10, paddingRight: 2, borderTopWidth: hairline, borderTopColor: colors.border }}>
      <Text selectable numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: 11, fontFamily: monoFont }}>{reference}</Text>
      {onOpen ? <Button theme={theme} label={t("coreRemoteInsights.locate")} icon="LocateFixed" size="sm" variant="ghost" accessibilityLabel={t("coreRemoteInsights.locateLabel")} onPress={onOpen} /> : null}
    </View>
  </View>;
}

function Finding({ theme, finding, index, evidence, onOpenEvidence }: {
  theme: PluginTheme; finding: InsightReport["findings"][number]; index: number; evidence: readonly InsightEvidence[]; onOpenEvidence?: (ref: string) => void;
}) {
  const { colors } = theme;
  const [open, setOpen] = useState(index === 0 || finding.severity === "high");
  const sources = useMemo(() => new Map(evidence.map(source => [source.ref, source])), [evidence]);
  return <View style={{ borderTopWidth: hairline, borderTopColor: colors.border }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }}
      accessibilityLabel={t("coreRemoteInsights.findingToggle", { value1: open ? t("coreRemoteInsights.collapse") : t("coreRemoteInsights.expand"), value2: finding.title })}
      onPress={() => setOpen(!open)} style={state => ({ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: space.md, opacity: state.pressed ? 0.75 : 1 })}>
      <View style={{ paddingTop: 6 }}><StatusDot theme={theme} tone={severityTones[finding.severity]} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "500", lineHeight: 20 }}>{finding.title}</Text>
        <MetaLine theme={theme} parts={[severityNames[finding.severity], categoryNames[finding.category]]} />
      </View>
      <View style={{ paddingTop: 3 }}><Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} /></View>
    </Pressable>
    {open ? <View style={{ gap: space.md, paddingBottom: space.lg, paddingLeft: 18 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{finding.detail}</Text>
      {finding.evidence.length ? <View style={{ gap: space.sm }}>{finding.evidence.map((reference, sourceIndex) =>
        <EvidenceSnippet key={`${sourceIndex}:${reference}`} theme={theme} reference={reference} source={sources.get(reference)}
          onOpen={onOpenEvidence ? () => onOpenEvidence(reference) : undefined} />)}</View> : null}
      <View style={{ gap: space.xs }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{t("coreRemoteInsights.recommendation")}</Text>
        <Text selectable style={{ color: colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{finding.recommendation}</Text>
      </View>
    </View> : null}
  </View>;
}

function ListSection({ theme, title, items }: { theme: PluginTheme; title: string; items: readonly string[] }) {
  if (!items.length) return null;
  return <View style={{ gap: space.sm }}>
    <PaneLabel theme={theme}>{title}</PaneLabel>
    {items.map((item, index) => <View key={`${index}:${item}`} style={{ flexDirection: "row", gap: space.sm }}>
      <Text style={{ width: 18, color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 22, fontVariant: ["tabular-nums"] }}>{index + 1}.</Text>
      <Text selectable style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{item}</Text>
    </View>)}
  </View>;
}

function Report({ theme, run, agent, onOpenEvidence }: { theme: PluginTheme; run: RemoteInsightRun; agent: AgentRecord; onOpenEvidence?: (ref: string) => void }) {
  const toast = useToast();
  const report = run.report;
  if (!report) return null;
  const copy = () => {
    void copyText(JSON.stringify({ agentId: agent.id, agentTitle: agent.title, analyzedAt: run.analyzedAt, runner: run.runner, coverage: run.coverage, counts: run.counts, report, evidence: run.evidence }, null, 2))
      .then(() => toast.show(t("coreRemoteInsights.copied"), { variant: "success" }))
      .catch(() => toast.error(t("coreRemoteInsights.copyFailed")));
  };
  return <View style={{ gap: space.xl }}>
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Badge theme={theme} label={healthNames[report.health]} tone={healthTones[report.health]} icon={report.health === "healthy" ? "CircleCheck" : "CircleAlert"} />
        <MetaLine theme={theme} parts={[
          t("coreRemoteInsights.confidence", { value1: confidenceNames[report.confidence] }),
          t("coreRemoteInsights.findings", { count: report.findings.length }),
          run.analyzedAt ? t("coreRemoteInsights.analyzedAt", { value1: relativeTime(run.analyzedAt) }) : null,
        ]} />
      </View>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.content, lineHeight: 24 }}>{report.summary}</Text>
      <MetaLine theme={theme} numberOfLines={2} parts={[
        run.coverage ? t("coreRemoteInsights.coverage", { value1: run.coverage.rows }) : null,
        run.coverage?.truncated ? t("coreRemoteInsights.limitedWindow") : null,
        run.counts ? t("coreRemoteInsights.turnsTools", { value1: run.counts.turns, value2: run.counts.tools }) : null,
      ]} />
    </View>
    {report.findings.length ? <View>
      <PaneLabel theme={theme}>{t("coreRemoteInsights.observations")}</PaneLabel>
      {report.findings.map((finding, index) =>
        <Finding key={`${finding.id}:${index}`} theme={theme} finding={finding} index={index} evidence={run.evidence} onOpenEvidence={onOpenEvidence} />)}
    </View> : null}
    <ListSection theme={theme} title={t("coreRemoteInsights.practices")} items={report.strengths} />
    <ListSection theme={theme} title={t("coreRemoteInsights.nextSteps")} items={report.nextActions} />
    <ListSection theme={theme} title={t("coreRemoteInsights.limits")} items={report.limitations} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
      <View style={{ marginLeft: -space.sm }}><Button theme={theme} icon="Copy" label={t("coreRemoteInsights.copy")} size="sm" variant="ghost" onPress={copy} /></View>
      <MetaLine theme={theme} numberOfLines={2} parts={[
        run.runner?.label,
        run.usage ? t("coreRemoteInsights.tokens", { value1: formatTokens(run.usage.inputTokens), value2: formatTokens(run.usage.outputTokens) }) : null,
      ]} />
    </View>
  </View>;
}

/**
 * The tab itself. `host` is the host this screen runs on — where the model will run; `serverId` is the observed one,
 * which is only ever read. They are never the same: the screen's host row excludes the current host.
 */
export function RemoteInsights({ theme, serverId, host, agent, remote, inset, header, onOpenEvidence }: {
  theme: PluginTheme;
  serverId: string;
  host: PluginScreenProps["host"];
  agent: AgentRecord;
  /** Borrows the observed host's connection when a run starts; it is read and nothing else. */
  remote: () => ResultApi;
  inset: number;
  header?: React.ReactNode;
  onOpenEvidence?: (ref: string) => void;
}) {
  const local = usePaseo();
  const analyst = useAnalyst(local, host.id, true);
  const run = useRemoteInsight({ remote, local, serverId, agentId: agent.id, agentTitle: agent.title, plan: analyst.data });
  const runnerLabel = analyst.data?.info.label ?? "";
  // Exactly one primary action on screen: inside the empty state while there is nothing to read, at the top once there
  // is a report to re-run. An empty state that only describes the feature leaves the reader hunting for the button.
  const startAction = analyst.data && !run.busy ? { label: t("coreRemoteInsights.start"), onPress: run.start, icon: "Sparkles" } : undefined;
  // Where it runs and what it may do, as one muted line. This is a disclosure, not a problem: a yellow banner over an
  // empty tab reads as something being broken when nothing is.
  const runnerLine = <MetaLine theme={theme} numberOfLines={2} parts={[
    runnerLabel ? t("coreRemoteInsights.runnerLine", { host: host.label, runner: runnerLabel }) : t("coreRemoteInsights.runsOn", { host: host.label }),
    analyst.data?.access === "ask" ? t("coreRemoteInsights.askAccess") : null,
  ]} />;
  const invitation = t("coreRemoteInsights.emptyMessage", { host: host.label, runner: runnerLabel || t("coreAgentDetail.analysis") });

  // A report survives a failed re-run, so a failure is a banner over it; with nothing to keep, it is the whole body.
  const body = run.busy ? <Progress theme={theme} run={run} host={host.label} />
    : analyst.isPending ? <EmptyState theme={theme} icon="Sparkles" tone="neutral" title={t("coreRemoteInsights.checkingRunner")} />
    : analyst.error ? <EmptyState theme={theme} icon="Sparkles" tone="warning" title={t("coreRemoteInsights.noRunnerTitle")} message={analyst.error.message} />
    : run.report ? <Report theme={theme} run={run} agent={agent} onOpenEvidence={onOpenEvidence} />
    : run.error ? <EmptyState theme={theme} icon="Sparkles" tone="danger" title={t("coreRemoteInsights.failedTitle")} message={run.error} action={startAction} />
    : run.notEligible ? <EmptyState theme={theme} icon="Sparkles" tone="warning" title={t("coreRemoteInsights.notEligibleTitle")} message={run.notEligible} action={startAction} />
    : <EmptyState theme={theme} icon="Sparkles" tone="info" title={t("coreRemoteInsights.emptyTitle")} message={invitation} action={startAction} />;

  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl, gap: space.md }}>
    {header}
    {/* Before the first report the body carries the invitation and the button; the top row is only the re-run control. */}
    {run.report ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingTop: space.lg }}>
      <Button theme={theme} icon="Sparkles" variant="primary" disabled={run.busy || !analyst.data}
        label={t("coreRemoteInsights.again")} onPress={run.start} />
      {runnerLine}
    </View> : null}
    {run.error && run.report ? <Banner theme={theme} tone="danger" message={run.error} /> : null}
    {body}
    {!run.report ? <View style={{ alignItems: "center" }}>{runnerLine}</View> : null}
  </ScrollView>;
}
