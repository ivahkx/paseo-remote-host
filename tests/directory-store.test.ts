// What a remote host's Sessions tab shows when its connection is only half working. The screen renders "Loading agents
// from <host>…" for as long as the directory reports loading with nothing read yet, so any path that leaves loading set
// forever is a blank screen with no error and no retry — the worst of the three outcomes a reader can get.
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentDirectory, type AgentDirectoryPage } from "../shared/directory-store";

const emptyPage: AgentDirectoryPage = { entries: [], pageInfo: { nextCursor: null, hasMore: false } };
const onePage = (id: string): AgentDirectoryPage => ({
  entries: [{ agent: { id, title: id, status: "idle", updatedAt: "2026-10-28T00:00:00.000Z" } as never }],
  pageInfo: { nextCursor: null, hasMore: false },
});
const never = <T,>(): Promise<T> => new Promise<T>(() => {});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a subscription handshake that never answers does not hold back the paged read", async () => {
  const directory = createAgentDirectory(
    { list: async (options) => (options.filter.requiresAttention ? emptyPage : onePage("a1")), observe: never },
    { includeArchived: false },
  );
  directory.subscribe(() => {});
  directory.start(true);
  await wait(4_500);
  const state = directory.getSnapshot();
  directory.stop();

  assert.equal(state.loading, false, "loading must clear even though the observation never attached");
  assert.equal(state.error, null);
  assert.deepEqual(state.agents.map((agent) => agent.id), ["a1"]);
  assert.equal(state.live, false, "no observation attached, so the list is not live");
});

test("a read that cannot answer at all is reported as an error, not as endless loading", async () => {
  const directory = createAgentDirectory(
    { list: async () => { throw new Error("Paseo connection changed; call getPaseoClient again: srv_x"); }, observe: never },
    { includeArchived: false },
  );
  directory.subscribe(() => {});
  directory.start(true);
  await wait(4_500);
  const state = directory.getSnapshot();
  directory.stop();

  assert.equal(state.loading, false);
  assert.match(state.error ?? "", /call getPaseoClient again/);
});

test("an observation that attaches late still gets a journaled read of its own", async () => {
  let listCalls = 0;
  let attach: (() => void) | null = null;
  const handle = { subscribe: () => () => {}, release: async () => {} };
  const directory = createAgentDirectory(
    {
      list: async () => { listCalls += 1; return emptyPage; },
      observe: () => new Promise((resolve) => { attach = () => resolve(handle); }),
    },
    { includeArchived: false },
  );
  directory.subscribe(() => {});
  directory.start(true);
  await wait(4_500);
  const afterGrace = listCalls;
  assert.ok(afterGrace > 0, "the read went ahead without the observation");

  attach!();
  await wait(300);
  directory.stop();

  assert.ok(listCalls > afterGrace, "attaching late queues a follow-up read so nothing missed meanwhile is lost");
});
