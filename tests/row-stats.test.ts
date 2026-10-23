// The Sessions row's metric strip. What matters here is not the formatting but which numbers are shown at all and which
// of them are filled red: a row is how a reviewer decides whether a session is worth opening, so a failure that reads
// like a neutral counter is the defect. Pure derivation over a folded digest; nothing is read to produce it.
import assert from "node:assert/strict";
import test from "node:test";
import { rowMetrics, statsSentence } from "../shared/row-stats";
import type { Digest, DigestTurn } from "../shared/digest";
import type { AgentRecord } from "../shared/model";

const turn = (index: number, outcome: DigestTurn["outcome"]): DigestTurn => ({
  index, turnId: `t${index}`, start: 0, end: 1, outcome, prompt: "", reply: "", tools: 0, failures: 0,
  lanes: { model: 0, read: 0, search: 0, edit: 0, shell: 0, web: 0, agent: 0, plan: 0, wait: 0, other: 0 },
  files: 0, added: 0, removed: 0, commands: 0, checksPassed: 0, checksFailed: 0,
  time: { model: 0, read: 0, search: 0, edit: 0, shell: 0, web: 0, agent: 0, plan: 0, wait: 0, other: 0 }, tokens: null,
});
const digest = (overrides: Partial<Digest["totals"]> = {}, extra: Partial<Digest> = {}): Digest => ({
  agentId: "a1", generatedAt: "2026-10-23T00:00:00.000Z", epoch: "e1", start: 0, end: 60_000, activeMs: 60_000, running: false,
  totals: { turns: 0, tools: 0, failures: 0, files: 0, added: 0, removed: 0, commands: 0, checksPassed: 0, checksFailed: 0,
    approvals: 0, waitMs: 0, errors: 0, compactions: 0, subagents: 0, messages: 0, thinking: 0, skills: 0, ...overrides },
  timeShare: { model: 0, read: 0, search: 0, edit: 0, shell: 0, web: 0, agent: 0, plan: 0, wait: 0, other: 0 },
  turns: [], segments: [], files: [], commands: [], checks: [], highlights: [], tokens: null,
  coverage: { rows: 10, truncated: false }, ...extra,
});
const agent = { usage: { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null } } as unknown as AgentRecord;
const keys = (stats: ReturnType<typeof rowMetrics>) => stats.metrics.map(metric => metric.key);
const find = (stats: ReturnType<typeof rowMetrics>, key: string) => stats.metrics.find(metric => metric.key === key);

test("a metric that carries nothing is left out, so a clean row stays short", () => {
  const stats = rowMetrics(digest({ turns: 3, tools: 12 }), agent);
  assert.deepEqual(keys(stats), ["time", "turns", "tools", "skills"]);
  assert.equal(find(stats, "skills")?.value, "0", "skills is stated even at zero: a missing one reads as unknown");
});

test("failures are filled red; ordinary counters are not", () => {
  const stats = rowMetrics(digest({ turns: 5, tools: 100, failures: 30, errors: 2, checksPassed: 1, checksFailed: 2 }, { turns: [turn(1, "completed"), turn(2, "failed")] }), agent);
  assert.equal(find(stats, "turnFails")?.alert, true);
  assert.equal(find(stats, "toolFails")?.alert, true, "30 of 100 tool calls failing must stop the eye");
  assert.equal(find(stats, "errors")?.alert, true);
  assert.equal(find(stats, "turns")?.alert, undefined);
  assert.equal(find(stats, "tools")?.alert, undefined);
});

test("tool failures carry their rate, and a low rate is coloured without being filled", () => {
  const low = rowMetrics(digest({ tools: 100, failures: 5 }), agent);
  assert.equal(find(low, "toolFails")?.value, "5 · 5%");
  assert.equal(find(low, "toolFails")?.alert, false, "5% is worth seeing, not worth shouting");
  assert.equal(find(low, "toolFails")?.hue, "red");
});

test("tool failures and runtime errors are counted apart, not summed", () => {
  const stats = rowMetrics(digest({ tools: 10, failures: 4, errors: 3 }), agent);
  assert.equal(find(stats, "toolFails")?.value.startsWith("4"), true);
  assert.equal(find(stats, "errors")?.value, "3");
});

test("checks count runs, not final state, so a fix loop is amber and only a never-green session is filled", () => {
  const clean = find(rowMetrics(digest({ checksPassed: 9, checksFailed: 0 }), agent), "checks");
  assert.equal(clean?.hue, "green");
  assert.equal(clean?.alert, false);
  // 27/29 is the shape of a red-green cycle that ended green; calling it a failure would be wrong.
  const loop = find(rowMetrics(digest({ checksPassed: 27, checksFailed: 2 }), agent), "checks");
  assert.equal(loop?.hue, "amber");
  assert.equal(loop?.alert, false);
  assert.equal(loop?.value, "27/29");
  // 1 of 7: most runs failed, so this one is filled.
  const mostlyRed = find(rowMetrics(digest({ checksPassed: 1, checksFailed: 6 }), agent), "checks");
  assert.equal(mostlyRed?.hue, "red");
  assert.equal(mostlyRed?.alert, true);
  const neverGreen = find(rowMetrics(digest({ checksPassed: 0, checksFailed: 6 }), agent), "checks");
  assert.equal(neverGreen?.hue, "red");
  assert.equal(neverGreen?.alert, true);
});

test("human waiting time rides along with the approval count", () => {
  const stats = rowMetrics(digest({ approvals: 4, waitMs: 12 * 60_000 }), agent);
  assert.equal(find(stats, "approvals")?.value, "4 · 12 min");
  assert.equal(find(rowMetrics(digest({ approvals: 2 }), agent), "approvals")?.value, "2", "no wait recorded, no wait claimed");
});

test("context compactions are reported: they are why later turns repeat earlier work", () => {
  assert.equal(find(rowMetrics(digest({ compactions: 3 }), agent), "compactions")?.value, "3");
  assert.equal(find(rowMetrics(digest(), agent), "compactions"), undefined);
});

test("tokens fall back to the agent's own reported usage when no ledger exists", () => {
  const reporting = { usage: { inputTokens: 9000, outputTokens: 1700, totalTokens: 10700, cachedInputTokens: 2000 } } as unknown as AgentRecord;
  assert.equal(find(rowMetrics(digest(), reporting), "tokens")?.value, "10.7k");
  assert.equal(find(rowMetrics(digest(), agent), "tokens"), undefined);
});

test("the signature changes with the values, so a row redraws when a number moves", () => {
  const before = rowMetrics(digest({ turns: 3, tools: 10 }), agent);
  assert.equal(before.signature, rowMetrics(digest({ turns: 3, tools: 10 }), agent).signature);
  assert.notEqual(before.signature, rowMetrics(digest({ turns: 4, tools: 10 }), agent).signature);
});

test("the strip reads as one sentence for a screen reader", () => {
  const stats = rowMetrics(digest({ turns: 2, tools: 8, errors: 1 }), agent);
  assert.equal(statsSentence(stats), "1 min · Turns 2 · Tool calls 8 · Skills 0 · Errors 1");
});
