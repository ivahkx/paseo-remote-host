// The Analysis tab's two halves: the prompt built from a trajectory read over a remote connection, and the temporary
// session that answers it on the host the screen is on. What is checked here is what must not regress — a credential
// never reaching the prompt, a cited ref the model invented never reaching the report, a session never running in a
// mode whose restriction was not verified, every tool request denied, and the session archived even when canceled.
import assert from "node:assert/strict";
import test from "node:test";
import { assessTrajectory, buildAnalysisRequest, parseInsightText } from "../shared/insight-analysis";
import { insightAnalysisMode, resolveAnalyst, runAnalysis, type AnalystApi } from "../shared/insight-runner";
import type { SessionTrajectory, TrajectoryRow } from "../shared/trajectory";

const row = (seq: number, kind: string, text: string, extra: Partial<TrajectoryRow> = {}): TrajectoryRow => ({
  ref: `agent-1:epoch-1:${seq}-${seq}`, epoch: "epoch-1", seqStart: seq, seqEnd: seq,
  at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), turnId: `turn-${Math.ceil(seq / 4)}`,
  kind, text, toolName: null, toolStatus: null, ...extra,
});
const SECRET = "sk-ant-api03-SECRETVALUEHERE0000";
const trajectory: SessionTrajectory = {
  agent: { id: "agent-1", title: "Fix the flaky test", provider: "claude", model: "opus", cwd: "/srv/app", workspaceId: "ws-9", archivedAt: null, status: "idle", attentionReason: "finished" },
  project: { id: "p1", name: "app", rootPath: "/srv/app" },
  capturedAt: "2026-10-23T09:00:00.000Z",
  rows: [
    row(1, "user_message", `the auth test keeps failing, token is ${SECRET}`),
    row(2, "tool_call", "tool: Bash\ncommand: npm test", { toolName: "Bash", toolStatus: "failed" }),
    row(3, "error", "AssertionError: expected 401 to equal 200"),
    row(4, "assistant_message", "I will look at the token refresh path."),
    row(5, "user_message", "try again"),
    row(6, "tool_call", "tool: Bash\ncommand: npm test", { toolName: "Bash", toolStatus: "ok" }),
  ],
  coverage: { complete: true, hasOlder: false, hasNewer: false, gap: false, truncated: false, reason: null, projectedItems: 6, characters: 400, pages: 1, firstAt: null, lastAt: null, epoch: "epoch-1", endSeq: 6 },
  counts: { userTurns: 2, assistantMessages: 1, tools: 2, toolFailures: 1, errors: 1, observedTurnIds: 2 },
  completionEvidence: { kind: "attention_finished", at: null },
};
const request = () => buildAnalysisRequest(trajectory, { language: "en", languageName: "English" });
const answer = (findings: unknown[]) => JSON.stringify({
  structured_output: {
    summary: "The auth test failed once and passed after a retry.", health: "watch", confidence: "medium",
    findings, strengths: ["Re-ran the suite to confirm."], nextActions: ["Pin the token fixture."], limitations: [],
  },
  usage: { input_tokens: 1200, output_tokens: 300 },
});
const cited = { id: "f1", severity: "medium", category: "failure", title: "Auth test failed on 401", detail: "npm test returned 401.", evidence: ["agent-1:epoch-1:2-2"], recommendation: "Check the refresh path." };
const invented = { id: "f2", severity: "low", category: "loop", title: "Invented", detail: "x", evidence: ["agent-1:epoch-1:999-999"], recommendation: "y" };

test("the prompt says the trajectory is another host's, and carries no credential", () => {
  const built = request();
  assert.ok(built.prompt.includes("read-only connection to another host"));
  assert.ok(built.prompt.includes("Do not call tools"));
  assert.ok(!built.prompt.includes(SECRET), "a credential reached the analysis prompt");
  assert.equal(built.references.size, trajectory.rows.length);
});

test("a finding citing a ref that was never sent is dropped and said so", () => {
  const built = request();
  const { report, usage } = parseInsightText(answer([cited, invented]), built.references);
  assert.deepEqual(report.findings.map(finding => finding.id), ["f1"]);
  assert.equal(report.confidence, "low");
  assert.equal(report.limitations.length, 1);
  assert.equal(usage?.inputTokens, 1200);
});

test("a trajectory too thin to review is reported rather than analysed", () => {
  assert.equal(assessTrajectory(trajectory).eligible, true);
  assert.equal(assessTrajectory({ ...trajectory, counts: { ...trajectory.counts, userTurns: 1 } }).eligible, false);
  assert.equal(assessTrajectory({ ...trajectory, counts: { ...trajectory.counts, tools: 0 } }).eligible, false);
});

test("only a mode whose restriction is known is ever used", () => {
  assert.equal(insightAnalysisMode([]).unsafe, true, "a provider listing no modes cannot be pinned to one");
  assert.equal(insightAnalysisMode([{ id: "default", colorTier: "dangerous" }] as never).unsafe, true);
  assert.equal(insightAnalysisMode([{ id: "default", colorTier: "safe" }] as never).access, "ask");
  assert.equal(insightAnalysisMode([{ id: "ask", colorTier: "safe" }] as never).access, "read");
  assert.equal(insightAnalysisMode([{ id: "auto", colorTier: "safe" }] as never, { codex: true }).providerOptions?.sandbox_mode, "read-only");
});

/** A host that answers with `reply`, after `attention` rounds of asking for a tool first. */
function fakeHost(options: { reply?: string; attention?: number; hang?: boolean } = {}) {
  const calls: string[] = [];
  let created: Record<string, unknown> | undefined;
  let rounds = 0;
  const handle = {
    id: "analysis-1",
    current: () => ({ lastUsage: { inputTokens: 1200, outputTokens: 300, totalCostUsd: 0.01 } }),
    refresh: async () => ({ agent: { pendingPermissions: [] } }),
    respondToPermission: async (input: { requestId: string; response: { behavior: string } }) => { calls.push(`${input.response.behavior}:${input.requestId}`); },
    waitForFinish: async () => {
      if (options.hang) { calls.push("wait"); return new Promise<never>(() => {}); }
      calls.push("wait");
      if (rounds++ < (options.attention ?? 0)) return { status: "needs_attention", final: { pendingPermissions: [{ id: `perm-${rounds}` }] } };
      return { status: "idle", lastMessage: options.reply ?? "", final: { lastUsage: { inputTokens: 1200, outputTokens: 300, totalCostUsd: 0.01 } } };
    },
    run: async () => { calls.push("rerun"); return { status: "idle", lastMessage: options.reply ?? "" }; },
    archive: async () => { calls.push("archive"); return { archivedAt: "2026-10-23T09:10:00.000Z" }; },
  };
  const api = {
    config: { get: async () => ({ requestId: "r", config: { providers: { claude: { enabled: true } } } }) },
    providers: { snapshot: async () => ({ entries: [
      { provider: "cursor", label: "Cursor", enabled: true, status: "ready", error: null, modes: [{ id: "ask", colorTier: "safe" }], models: [{ id: "auto", isDefault: true, label: "Auto" }] },
      { provider: "claude", label: "Claude Code", enabled: true, status: "ready", error: null, modes: [{ id: "ask", colorTier: "safe" }], models: [{ id: "opus", isDefault: true, label: "Opus" }] },
    ], compactSnapshot: null }) },
    workspaces: {
      list: async () => ({ entries: [
        { id: "ws-old", archivingAt: null, activityAt: "2026-01-01T00:00:00.000Z" },
        { id: "ws-new", archivingAt: null, activityAt: "2026-10-01T00:00:00.000Z" },
        { id: "ws-closing", archivingAt: "2026-10-02T00:00:00.000Z", activityAt: "2026-10-03T00:00:00.000Z" },
      ], pageInfo: {} }),
      ref: (id: string) => ({ agents: { create: async (input: Record<string, unknown>) => { calls.push(`create:${id}`); created = input; return handle; } } }),
    },
  } as unknown as AnalystApi;
  return { api, calls, createdOptions: () => created };
}

test("auto picks Claude Code over another ready provider, with its default model", async () => {
  const plan = await resolveAnalyst(fakeHost().api);
  assert.equal(plan.info.provider, "claude");
  assert.equal(plan.info.model, "opus");
  assert.equal(plan.info.modeId, "ask");
  assert.equal(plan.access, "read");
});

test("a run creates in the newest open workspace, denies every tool request, and archives", async () => {
  const built = request();
  const host = fakeHost({ reply: answer([cited]), attention: 1 });
  const plan = await resolveAnalyst(host.api);
  const result = await runAnalysis({
    paseo: host.api, plan, prompt: built.prompt, systemPrompt: "system", title: "Analysis of Fix the flaky test",
    labels: { "remote-host.role": "insight" }, parse: text => parseInsightText(text, built.references), signal: new AbortController().signal,
  });
  assert.deepEqual(host.calls, ["create:ws-new", "wait", "deny:perm-1", "wait", "archive"]);
  const config = host.createdOptions()?.config as Record<string, unknown>;
  assert.equal(config.provider, "claude/opus");
  assert.equal(config.modeId, "ask");
  assert.equal(config.systemPrompt, "system");
  assert.ok(host.createdOptions()?.outputSchema, "the structured output schema must be sent");
  assert.equal(result.runner.sessionAgentId, "analysis-1");
  assert.deepEqual(result.value.report.findings.map(finding => finding.id), ["f1"]);
});

test("a canceled run still archives its session", async () => {
  const built = request();
  const host = fakeHost({ hang: true });
  const plan = await resolveAnalyst(host.api);
  const aborter = new AbortController();
  const pending = runAnalysis({
    paseo: host.api, plan, prompt: "p", systemPrompt: "s", title: "t", labels: {},
    parse: text => parseInsightText(text, built.references), signal: aborter.signal,
  }).then(() => "resolved", (error: Error) => error.message);
  await new Promise(resolve => setTimeout(resolve, 20));
  aborter.abort();
  assert.match(await pending, /canceled/);
  assert.deepEqual(host.calls, ["create:ws-new", "wait", "archive"]);
});

test("an answer with no evidence behind it is refused rather than shown", async () => {
  const built = request();
  const empty = JSON.stringify({ summary: "I need to read the full trajectory first.", health: "watch", confidence: "low",
    findings: [], strengths: [], nextActions: [], limitations: [] });
  assert.throws(() => parseInsightText(empty, built.references), /evidence-based/);
});
