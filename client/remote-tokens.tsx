// Per-agent token usage for a remote host, summed client-side from the directory snapshot the app already borrows.
// Paseo exposes only each agent's latest in-memory usage over the wire (AgentUsage inputTokens/outputTokens, normalized
// into AgentRecord.usage), so this is a live snapshot of loaded agents — not the server's full historical token ledger.
import { t } from "../shared/text";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import type { AgentRecord } from "../shared/model";
import { bigNumber } from "../shared/stats-view";
import { fontSize, hairline, space } from "./kit";

interface Row {
  id: string;
  title: string;
  input: number;
  output: number;
  total: number;
}

function Stat({ theme, label, value }: { theme: PluginTheme; label: string; value: string }) {
  return (
    <View style={{ flex: 1, gap: space.xxs }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{label}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: fontSize.heading, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

export function RemoteTokens({ agents, theme, compact }: { agents: readonly AgentRecord[]; theme: PluginTheme; compact: boolean }) {
  const { rows, input, output } = useMemo(() => {
    const result: Row[] = [];
    let input = 0;
    let output = 0;
    for (const agent of agents) {
      const agentInput = agent.usage.inputTokens ?? 0;
      const agentOutput = agent.usage.outputTokens ?? 0;
      const total = agentInput + agentOutput;
      if (total <= 0) continue;
      input += agentInput;
      output += agentOutput;
      result.push({ id: agent.id, title: agent.title || agent.id, input: agentInput, output: agentOutput, total });
    }
    result.sort((a, b) => b.total - a.total);
    return { rows: result, input, output };
  }, [agents]);

  const pad = compact ? space.md : space.lg;
  if (!rows.length) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.body, textAlign: "center" }}>
          {t("coreRemoteHost.noTokenUsage")}
        </Text>
      </View>
    );
  }
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: space.md }}>
      <View style={{ flexDirection: "row", gap: space.md, padding: space.md, borderRadius: 10, borderWidth: hairline, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
        <Stat theme={theme} label={t("coreRemoteHost.tokensInput")} value={bigNumber(input)} />
        <Stat theme={theme} label={t("coreRemoteHost.tokensOutput")} value={bigNumber(output)} />
        <Stat theme={theme} label={t("coreRemoteHost.tokensTotal")} value={bigNumber(input + output)} />
      </View>
      <View style={{ gap: space.xs }}>
        {rows.map((row) => (
          <View key={row.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, borderBottomWidth: hairline, borderBottomColor: theme.colors.border }}>
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.body }}>{row.title}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"], width: 72, textAlign: "right" }}>{t("coreRemoteHost.tokensIn", { value1: bigNumber(row.input) })}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"], width: 72, textAlign: "right" }}>{t("coreRemoteHost.tokensOut", { value1: bigNumber(row.output) })}</Text>
            <Text style={{ color: theme.colors.accent, fontSize: fontSize.body, fontWeight: "600", fontVariant: ["tabular-nums"], width: 64, textAlign: "right" }}>{bigNumber(row.total)}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
