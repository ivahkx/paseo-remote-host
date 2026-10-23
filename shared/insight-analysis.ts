// The analysis prompt and its answer, moved out of Agent Observatory's server/insight-analysis.ts so this plugin can run
// both in the app. Everything here is pure string work: no node:crypto (the server's trajectory fingerprint is for its
// job cache, which this plugin has no need of), no file system, no host runtime. The one call that is not pure — asking
// a model — happens in shared/insight-runner.ts against the host this screen is on, never against the observed one.
import { t } from "./text";
import { insightReportSchema, type InsightJob, type InsightReport } from "./insights";
import type { SessionTrajectory, TrajectoryRow } from "./trajectory";
import { excerptText } from "./evidence";
import { isCredentialField, redactSecrets, redactStrings } from "./redact";

/** Whether a trajectory carries enough to review. Manual only: this plugin never starts an analysis by itself. */
export function assessTrajectory(trajectory: SessionTrajectory, minimumTurns = 2, minimumTools = 2) {
  const turnCount = trajectory.counts.userTurns, toolCount = trajectory.counts.tools;
  if (turnCount < minimumTurns) return { eligible: false, turnCount, toolCount, reason: t("sharedInsightAnalysis.needTurns", { turnsNeeded: minimumTurns, turnCount }) };
  if (toolCount < minimumTools) return { eligible: false, turnCount, toolCount, reason: t("sharedInsightAnalysis.needTools", { toolsNeeded: minimumTools, toolCount }) };
  return { eligible: true, turnCount, toolCount, reason: t("sharedInsightAnalysis.eligible", { turnCount, toolCount }) };
}
export type TrajectoryAssessment = ReturnType<typeof assessTrajectory>;

function evenly<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 1) return count ? [items[0]] : [];
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * (items.length - 1) / (count - 1))]);
}
/** Keep the shape of the run when the window is larger than the prompt: both ends, the instructions, and every failure. */
function selectAnalysisRows(rows: readonly TrajectoryRow[], limit: number): TrajectoryRow[] {
  if (rows.length <= limit) return [...rows];
  const selected = new Set<number>();
  const indexes = rows.map((_, index) => index);
  const take = (candidates: number[], count: number) => { for (const index of evenly(candidates, count)) if (selected.size < limit) selected.add(index); };
  take([0, rows.length - 1], 2);
  take(indexes.filter(index => rows[index].kind === "user_message"), Math.floor(limit / 3));
  take(indexes.filter(index => rows[index].kind === "error" || rows[index].toolStatus === "failed"), Math.floor(limit / 3));
  take(indexes.filter(index => rows[index].kind === "tool_call"), Math.floor(limit / 3));
  take(indexes.filter(index => rows[index].kind === "assistant_message"), Math.floor(limit / 6));
  take(indexes.filter(index => !selected.has(index)), limit - selected.size);
  return [...selected].sort((a, b) => a - b).map(index => rows[index]);
}

export interface AnalysisRequestOptions {
  /** The report's language, and its own name in it, for the instruction that asks for it. */
  language: string; languageName: string;
  question?: string;
}
export interface AnalysisRequest { prompt: string; references: Set<string>; evidence: TrajectoryRow[]; sampled: boolean }
/**
 * The prompt and the set of refs a report may cite. The trajectory was read from another host, so the instructions say
 * so: the model must not try to open a path or run a command it reads, because none of it exists where it runs.
 */
export function buildAnalysisRequest(trajectory: SessionTrajectory, options: AnalysisRequestOptions): AnalysisRequest {
  const limit = 120000;
  const selected = selectAnalysisRows(trajectory.rows, 180);
  // Masked before it is cut, with the field names in mind (see summarizeTrajectoryRow).
  const safeMetadata = (value: unknown, secret = false): unknown => {
    if (typeof value === "string") return excerptText(secret && value ? "[redacted]" : redactSecrets(value), 1000).text;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeMetadata(entry, secret || isCredentialField(key))]));
    return value;
  };
  const instructions = [
    t("sharedInsightAnalysis.role", { language: options.language, languageName: options.languageName }),
    t("sharedInsightAnalysis.noTools"),
    t("sharedInsightAnalysis.remote"),
    t("sharedInsightAnalysis.submitNow"),
    t("sharedInsightAnalysis.focus"),
    t("sharedInsightAnalysis.citeEvidence"),
    t("sharedInsightAnalysis.healthRules"),
    t("sharedInsightAnalysis.jsonFields"),
    options.question ? t("sharedInsightAnalysis.question", { value1: redactSecrets(options.question).slice(0, 2000) }) : "",
  ].filter(Boolean).join("\n\n");
  let perRow = Math.min(4200, Math.floor((limit - 16000) / Math.max(1, selected.length) * 0.72));
  let evidence = selected;
  let prompt = "";
  let sampled = selected.length < trajectory.rows.length;
  for (let attempt = 0; attempt < 8; attempt++) {
    evidence = selected.map(row => {
      const excerpt = excerptText(redactSecrets(row.text), Math.max(20, perRow));
      sampled ||= excerpt.truncated;
      return { ...row, text: excerpt.text };
    });
    const data = { agent: safeMetadata(trajectory.agent), project: safeMetadata(trajectory.project), capturedAt: trajectory.capturedAt,
      coverage: safeMetadata(trajectory.coverage), counts: trajectory.counts,
      analysisWindow: { providedRows: evidence.length, sourceRows: trajectory.rows.length, sampled, sourceCountsAreWindowTotals: true, readOverRemoteConnection: true },
      rows: evidence.map(row => ({ ref: row.ref, at: row.at, turnId: row.turnId, type: row.kind, tool: row.toolName, status: row.toolStatus, text: row.text })) };
    prompt = `${instructions}\n\n<trajectory_data>${JSON.stringify(data)}</trajectory_data>`;
    if (prompt.length <= limit) break;
    perRow = Math.floor(perRow * 0.6);
  }
  if (prompt.length > limit) throw new Error(t("sharedInsightAnalysis.tooLarge"));
  return { prompt, references: new Set(evidence.map(row => row.ref)), evidence, sampled };
}

export class InsightReportError extends Error {
  constructor(message: string, readonly usage: InsightJob["usage"] = null) { super(message); this.name = "InsightReportError"; }
}
/** A report that only promises to analyse later, or cites nothing, is not a report. */
export function isUsefulInsightReport(report: InsightReport | null): boolean {
  if (!report) return false;
  if (report.findings.some(finding => finding.evidence.length > 0 && finding.detail.trim())) return true;
  if (report.strengths.some(item => item.trim())) return true;
  return report.nextActions.some(item => item.trim() && !/(?:读取|提供|获取).*(?:完整|更多|全部).*(?:轨迹|数据)|先.*读取/i.test(item)); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
}
/** Parse plain JSON, a fenced object, or a complete object in surrounding text. Models sometimes repeat the whole answer, so the last object `accept` approves wins; otherwise the largest one. */
export function extractInsightJson(output: string, accept?: (value: unknown) => boolean): unknown {
  const text = output.trim();
  if (text.length > 4_000_000) throw new InsightReportError(t("sharedInsightAnalysis.outputTooLarge"));
  try { return JSON.parse(text); } catch { /* providers sometimes add a fence or preamble */ }
  const spans: Array<[number, number]> = []; let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) { if (char === "{") { start = index; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { spans.push([start, index + 1]); start = -1; }
  }
  const objects = spans.flatMap(([from, to]) => { try { return [{ value: JSON.parse(text.slice(from, to)) as unknown, size: to - from }]; } catch { return []; } });
  const accepted = accept ? objects.filter(object => accept(object.value)) : [];
  const chosen = accepted.at(-1) ?? objects.sort((a, b) => b.size - a.size)[0];
  if (chosen) return chosen.value;
  throw new InsightReportError(t("sharedInsightAnalysis.notJson"));
}
export function parseInsightOutput(output: string, accept?: (value: unknown) => boolean): { data: unknown; usage: InsightJob["usage"] } {
  const envelope = extractInsightJson(output);
  const object = envelope !== null && typeof envelope === "object" ? envelope as Record<string, unknown> : {};
  const body = object.structured_output ?? object.structuredOutput ?? object.text ?? object.result ?? envelope;
  const usage = object.usage && typeof object.usage === "object" ? object.usage as Record<string, unknown> : {};
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const reportedUsage = { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), costUsd: number(object.total_cost_usd) };
  try { return { data: typeof body === "string" ? extractInsightJson(body, accept) : body, usage: reportedUsage }; }
  catch (error) { throw new InsightReportError(error instanceof Error ? error.message : t("sharedInsightAnalysis.noJson"), reportedUsage); }
}
/** A report whose findings all cite a ref that was really sent; anything else is dropped and the confidence lowered. */
export function parseInsightText(output: string, references: Set<string>): { report: InsightReport; usage: InsightJob["usage"] } {
  const { data, usage: reportedUsage } = parseInsightOutput(output, value => insightReportSchema.safeParse(value).success);
  const parsed = insightReportSchema.safeParse(redactStrings(data));
  if (!parsed.success) throw new InsightReportError(t("sharedInsightAnalysis.badFields"), reportedUsage);
  const report = parsed.data;
  let unsupported = 0, invalidReferences = 0;
  report.findings = report.findings.flatMap(finding => {
    invalidReferences += finding.evidence.filter(ref => !references.has(ref)).length;
    const evidence = [...new Set(finding.evidence.filter(ref => references.has(ref)))];
    if (!evidence.length) { unsupported++; return []; }
    return [{ ...finding, evidence }];
  });
  if (unsupported || invalidReferences) {
    report.confidence = "low";
    report.limitations = [...report.limitations.slice(0, 7), t("sharedInsightAnalysis.filtered", { invalidReferences, unsupported })];
    if (!report.findings.length) report.health = "watch";
  }
  if (!isUsefulInsightReport(report)) throw new InsightReportError(t("sharedInsightAnalysis.noConclusions"), reportedUsage);
  return { report, usage: reportedUsage };
}
