// The per-row metric strip of the remote Sessions list. It used to be one grey run-on sentence
// ("1 hr 7 min · Turns 15 · Thinking 170 · …"), which carried every number but let none of them stand out: a session
// with 7 errors read exactly like one with none. Each metric is its own labelled chip now, coloured by what it means,
// and the ones that should stop the eye — failed turns, failed tool calls, failed checks, errors — are filled rather
// than tinted. What to draw is decided in shared/row-stats.ts; this file only turns it into pixels.
import { t } from "../shared/text";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { hue, radius } from "./kit";
import type { RowMetric, RowStats } from "../shared/row-stats";

function Stat({ theme, metric }: { theme: PluginTheme; metric: RowMetric }) {
  const solid = metric.alert === true;
  const mark = hue(theme, metric.hue, "solid");
  const label = solid ? "#ffffff" : theme.colors.foregroundMuted;
  const value = solid ? "#ffffff" : hue(theme, metric.hue, "text");
  return <View accessibilityLabel={metric.label ? t("coreRemoteStats.statSpoken", { label: metric.label, value1: metric.value }) : t("coreRemoteStats.statSpoken", { label: t("coreRemoteStats.runtime"), value1: metric.value })}
    style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 17, paddingHorizontal: 5, borderRadius: radius.sm,
      backgroundColor: solid ? mark : hue(theme, metric.hue, "soft") }}>
    {metric.icon ? <Icon name={metric.icon} size={9} color={label} /> : null}
    {metric.label ? <Text numberOfLines={1} style={{ color: label, fontSize: 10, fontWeight: "500" }}>{metric.label}</Text> : null}
    <Text numberOfLines={1} style={{ color: value, fontSize: 10, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{metric.value}</Text>
  </View>;
}

/** The strip under a row. It wraps rather than truncating: the last chips are the ones a reviewer came for. */
export function RowStatStrip({ theme, stats }: { theme: PluginTheme; stats: RowStats }) {
  if (!stats.metrics.length) return null;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4, rowGap: 3, paddingTop: 1 }}>
    {stats.metrics.map(metric => <Stat key={metric.key} theme={theme} metric={metric} />)}
  </View>;
}
