// Decision signals for a remote host, computed client-side with the shared decisionSignals() over the borrowed directory
// snapshot and the reconstructed event feed. These are evidence-bound hints (waiting, quiet, unread, repeated failures),
// not inferred verdicts.
import { t } from "../shared/text";
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { DecisionSignal } from "../shared/decision-signals";
import { fontSize, hairline, relativeTime, space } from "./kit";

/** The dashboard's own wording for these very signal kinds (client/dashboard.tsx), so both screens read alike. */
function labelOf(signal: DecisionSignal): string {
  if (signal.kind === "repeated_failure") return t("coreDashboard.failedTimes", { value1: signal.count });
  const base = signal.kind === "permission" ? t("secondarySessionList.needsYou")
    : signal.kind === "unread" ? t("coreRemoteHost.signalUnread")
    : t("coreDashboard.noRecentUpdates");
  return signal.count > 1 ? t("coreRemoteHost.signalCount", { value1: base, value2: signal.count }) : base;
}

function toneOf(theme: PluginTheme, kind: DecisionSignal["kind"]): string {
  if (kind === "permission") return theme.colors.statusWarning;
  if (kind === "repeated_failure") return theme.colors.statusDanger;
  if (kind === "unread") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

export function RemoteSignals({ signals, theme, compact, now, onSelect }: { signals: readonly DecisionSignal[]; theme: PluginTheme; compact: boolean; now: number; onSelect: (agentId: string) => void }) {
  const pad = compact ? space.md : space.lg;
  if (!signals.length) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.body, textAlign: "center" }}>{t("coreRemoteHost.noSignals")}</Text>
      </View>
    );
  }
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: space.xs }}>
      {signals.map((signal, index) => {
        const tone = toneOf(theme, signal.kind);
        const label = labelOf(signal);
        return (
          <Pressable
            key={`${signal.kind}:${signal.agentId}:${index}`}
            accessibilityRole="button"
            accessibilityLabel={t("coreRemoteHost.signalSpoken", { value1: label, value2: signal.title })}
            onPress={() => onSelect(signal.agentId)}
            style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: 10, borderWidth: hairline, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />
            <View style={{ flex: 1, gap: space.xxs }}>
              <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{signal.title}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>
                {label}
                {signal.since ? ` · ${relativeTime(signal.since, now)}` : ""}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
