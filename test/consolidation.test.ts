import assert from "node:assert/strict";
import { test } from "node:test";
import { MementoCli } from "../src/cli.ts";
import {
  CLAIM_TTL_SECONDS,
  consolidateOnce,
  describePass,
  PASS_BUDGET_MS,
} from "../src/consolidation.ts";
import { type Call, fails, fakeEngine, ok } from "./helpers.ts";

const READS = {
  prefix: [ok({ text: "current memory" })],
  facts: [ok({ fingerprint: "fp-1" })],
  journal: [ok({ turns: [{ text: "a turn" }] })],
};

const engine = (script: Record<string, ReturnType<typeof ok>[]>) => {
  const { exec, calls } = fakeEngine(script);
  const cli = new MementoCli({
    store: "/store",
    queue: "/store/.queue",
    adapterFile: "/adapter.json",
    exec,
  });
  return { cli, calls };
};

const pass = (
  cli: MementoCli,
  overrides: Partial<Parameters<typeof consolidateOnce>[0]> = {},
  proposal: unknown = { facts: { a: 1 } },
) =>
  consolidateOnce({
    cli,
    session: "260814-120000",
    idleSeconds: 600,
    prefixMaterialized: true,
    distill: async () => proposal,
    ...overrides,
  });

const verbs = (calls: Call[]) => calls.map((c) => c.verb);

test("the happy path runs the contract's verbs, in the contract's order", async () => {
  const { cli, calls } = engine({
    ...READS,
    pending: [ok()],
    claim: [ok({ token: "t-1" })],
    commit: [ok({ sha: "abc123def456" })],
  });
  const report = await pass(cli);

  assert.equal(report.outcome, "consolidated");
  assert.equal(report.sha, "abc123def456");
  assert.equal(report.released, true);
  assert.deepEqual(verbs(calls), [
    "pending", // 1. the gate check
    "claim", // 2. the claim
    "prefix", // 3. reads
    "journal",
    "facts",
    "consolidate", // 5. submit
    "commit", // 6. back it up
    "done", // 7. the marker, last
    "release", // 8. give the claim back
  ]);
});

test("every call carries --json and the store; consolidate always carries --expect", async () => {
  const { cli, calls } = engine({ ...READS, pending: [ok()], claim: [ok({ token: "t" })] });
  await pass(cli);
  for (const call of calls) {
    assert.equal(call.args[0], "--store");
    assert.equal(call.args[1], "/store");
    assert.ok(call.args.includes("--json"), `${call.verb} must ask for the payload`);
    assert.equal(call.args.includes("--unchecked"), false, "the wrapper cannot reach --unchecked");
    assert.equal(
      call.args.includes("--adapter"),
      false,
      "agents declare adapters by file, never by module",
    );
  }
  const consolidate = calls.find((c) => c.verb === "consolidate");
  assert.ok(consolidate?.args.includes("--expect"));
  assert.equal(consolidate?.args[consolidate.args.indexOf("--expect") + 1], "fp-1");
  assert.ok(consolidate?.args.includes("--adapter-file"));
});

test("the gate check is first, mandatory, and passes what was observed", async () => {
  const { cli, calls } = engine({ pending: [fails(7, "not idle enough")] });
  const report = await pass(cli, { idleSeconds: 3, prefixMaterialized: false });

  assert.equal(report.outcome, "gate-refused");
  assert.deepEqual(verbs(calls), ["pending"], "a refusal stops the pass — nothing is claimed");
  const gate = calls[0];
  assert.ok(gate?.args.includes("--gate-check"));
  assert.equal(gate?.args[gate.args.indexOf("--idle-seconds") + 1], "3");
  assert.equal(
    gate?.args.includes("--prefix-materialized"),
    false,
    "the flag is only passed when the prefix was actually materialized",
  );
});

test("exit 6: another front-end holds it, so it is skipped and never forced", async () => {
  const { cli, calls } = engine({ pending: [ok()], claim: [fails(6, "claimed")] });
  const report = await pass(cli);
  assert.equal(report.outcome, "claimed-elsewhere");
  assert.deepEqual(verbs(calls), ["pending", "claim"]);
  assert.equal(
    calls.some((c) => c.verb === "release"),
    false,
    "someone else's claim is not released",
  );
});

test("exit 3: one corrected resubmit, with the violations handed back, then release and report", async () => {
  const { cli, calls } = engine({
    pending: [ok()],
    claim: [ok({ token: "t" })],
    prefix: [ok({ text: "p" }), ok({ text: "p" })],
    journal: [ok({ turns: [] }), ok({ turns: [] })],
    facts: [ok({ fingerprint: "fp-1" }), ok({ fingerprint: "fp-1" })],
    consolidate: [fails(3, "gates"), fails(3, "gates again")],
  });
  const seen: (unknown[] | undefined)[] = [];
  const report = await consolidateOnce({
    cli,
    session: "s1",
    idleSeconds: 60,
    prefixMaterialized: true,
    distill: async (input) => {
      seen.push(input.violations);
      return { facts: {} };
    },
  });

  assert.equal(report.outcome, "gates-rejected");
  assert.equal(report.attempts, 2, "exactly one correction");
  assert.equal(report.released, true, "the claim always comes back");
  assert.equal(seen.length, 2);
  assert.equal(seen[0], undefined);
  assert.deepEqual(seen[1], undefined, "violations ride in the payload; this engine sent none");
  assert.equal(verbs(calls).filter((v) => v === "consolidate").length, 2);
  assert.equal(verbs(calls).at(-1), "release");
});

test("exit 3 hands the violations to the corrected attempt when the engine reports them", async () => {
  const { cli } = engine({
    pending: [ok()],
    claim: [ok({ token: "t" })],
    prefix: [ok({ text: "p" }), ok({ text: "p" })],
    journal: [ok({ turns: [] }), ok({ turns: [] })],
    facts: [ok({ fingerprint: "fp" }), ok({ fingerprint: "fp" })],
    consolidate: [
      { code: 3, payload: { ok: false, violations: [{ rule: "anti-erosion" }] } },
      ok(),
    ],
    commit: [ok()],
  });
  const seen: (unknown[] | undefined)[] = [];
  const report = await consolidateOnce({
    cli,
    session: "s1",
    idleSeconds: 60,
    prefixMaterialized: true,
    distill: async (input) => {
      seen.push(input.violations);
      return { facts: {} };
    },
  });
  assert.deepEqual(
    seen[1],
    [{ rule: "anti-erosion" }],
    "the corrected attempt is told what was wrong",
  );
  assert.equal(report.outcome, "consolidated");
});

test("exit 5: the store moved, so the proposal is redriven once against fresh state", async () => {
  const { cli, calls } = engine({
    pending: [ok()],
    claim: [ok({ token: "t" })],
    prefix: [ok({ text: "old" }), ok({ text: "new" })],
    journal: [ok({ turns: [] }), ok({ turns: [] })],
    facts: [ok({ fingerprint: "fp-1" }), ok({ fingerprint: "fp-2" })],
    consolidate: [fails(5, "stale"), ok()],
    commit: [ok()],
  });
  const report = await pass(cli);

  assert.equal(
    report.outcome,
    "consolidated",
    "a stale fingerprint is a normal outcome, not an error",
  );
  const submits = calls.filter((c) => c.verb === "consolidate");
  assert.equal(submits[0]?.args[submits[0].args.indexOf("--expect") + 1], "fp-1");
  assert.equal(
    submits[1]?.args[submits[1].args.indexOf("--expect") + 1],
    "fp-2",
    "redriven against the new baseline",
  );
});

test("exit 5 twice gives up rather than spinning", async () => {
  const { cli, calls } = engine({
    pending: [ok()],
    claim: [ok({ token: "t" })],
    prefix: [ok({ text: "p" }), ok({ text: "p" })],
    journal: [ok({ turns: [] }), ok({ turns: [] })],
    facts: [ok({ fingerprint: "a" }), ok({ fingerprint: "b" })],
    consolidate: [fails(5), fails(5)],
  });
  const report = await pass(cli);
  assert.equal(report.outcome, "stale");
  assert.equal(report.released, true);
  assert.equal(calls.filter((c) => c.verb === "consolidate").length, 2);
});

test("exit 4: secrets are never retried, in any form", async () => {
  const { cli, calls } = engine({
    ...READS,
    pending: [ok()],
    claim: [ok({ token: "t" })],
    consolidate: [fails(4, "credential-shaped string")],
  });
  const report = await pass(cli);
  assert.equal(report.outcome, "secrets");
  assert.equal(report.detail, "credential-shaped string");
  assert.equal(calls.filter((c) => c.verb === "consolidate").length, 1, "once, and never again");
  assert.equal(verbs(calls).at(-1), "release");
  assert.equal(describePass(report).level, "error");
});

test("exit 2: malformed input never reached the gates, and is reported as its own thing", async () => {
  const { cli } = engine({
    ...READS,
    pending: [ok()],
    claim: [ok({ token: "t" })],
    consolidate: [fails(2, "not an object")],
  });
  const report = await pass(cli);
  assert.equal(report.outcome, "malformed");
  assert.equal(report.released, true);
});

test("exit 1: a usage or I/O error is surfaced, not retried blind", async () => {
  const { cli, calls } = engine({
    ...READS,
    pending: [ok()],
    claim: [ok({ token: "t" })],
    consolidate: [fails(1, "no such adapter file")],
  });
  const report = await pass(cli);
  assert.equal(report.outcome, "usage-error");
  assert.equal(report.detail, "no such adapter file");
  assert.equal(calls.filter((c) => c.verb === "consolidate").length, 1);
});

test("a distiller that proposes nothing writes nothing and still releases", async () => {
  const { cli, calls } = engine({ ...READS, pending: [ok()], claim: [ok({ token: "t" })] });
  const report = await pass(cli, { distill: async () => undefined });
  assert.equal(report.outcome, "nothing-pending");
  assert.equal(report.released, true);
  assert.equal(
    calls.some((c) => c.verb === "consolidate"),
    false,
  );
});

test("the claim is released with the token it was given, and a refusal is a FLAG", async () => {
  const { cli, calls } = engine({
    ...READS,
    pending: [ok()],
    claim: [ok({ token: "t-42" })],
    commit: [ok()],
    release: [fails(6, "wrong token")],
  });
  const report = await pass(cli);
  assert.equal(report.outcome, "consolidated");
  assert.equal(report.released, false, "a claim that did not come back is reported, never assumed");

  const release = calls.find((c) => c.verb === "release");
  assert.equal(release?.args[release.args.indexOf("--token") + 1], "t-42");
  const claim = calls.find((c) => c.verb === "claim");
  assert.equal(claim?.args[claim.args.indexOf("--ttl") + 1], String(CLAIM_TTL_SECONDS));
});

test("the pass is bounded well inside the claim's TTL", () => {
  assert.ok(
    PASS_BUDGET_MS / 1000 < CLAIM_TTL_SECONDS,
    "a pass that outlives its claim is a pass with no claim",
  );
  assert.equal(PASS_BUDGET_MS, 600_000);
  assert.equal(CLAIM_TTL_SECONDS, 3_600);
});

test("a spent budget gives the claim back rather than holding it", async () => {
  const { cli, calls } = engine({ ...READS, pending: [ok()], claim: [ok({ token: "t" })] });
  let clock = 0;
  const report = await consolidateOnce({
    cli,
    session: "s1",
    idleSeconds: 60,
    prefixMaterialized: true,
    budgetMs: 10,
    now: () => {
      clock += 100;
      return clock;
    },
    distill: async () => ({ facts: {} }),
  });
  assert.equal(report.outcome, "budget-exhausted");
  assert.equal(report.released, true);
  assert.equal(verbs(calls).at(-1), "release");
});

test("an abort gives the claim back too", async () => {
  const { cli } = engine({ ...READS, pending: [ok()], claim: [ok({ token: "t" })] });
  const abort = new AbortController();
  abort.abort();
  const report = await pass(cli, { signal: abort.signal });
  assert.equal(report.outcome, "budget-exhausted");
  assert.equal(report.released, true);
});

test("the marker is written after the commit, never before it", async () => {
  const { cli, calls } = engine({
    ...READS,
    pending: [ok()],
    claim: [ok({ token: "t" })],
    commit: [ok({ sha: "s" })],
  });
  await pass(cli);
  const order = verbs(calls);
  assert.ok(
    order.indexOf("commit") < order.indexOf("done"),
    "a crash between them must lose the marker, not the backup",
  );
  assert.ok(order.indexOf("consolidate") < order.indexOf("commit"));
});

test("every outcome has an operator-readable line", () => {
  const outcomes = [
    "consolidated",
    "gate-refused",
    "claimed-elsewhere",
    "nothing-pending",
    "gates-rejected",
    "malformed",
    "secrets",
    "stale",
    "usage-error",
    "budget-exhausted",
  ] as const;
  for (const outcome of outcomes) {
    const described = describePass({ outcome, session: "s1", attempts: 1 });
    assert.ok(described.text.startsWith("MEMENTO"), outcome);
    assert.ok(["info", "warning", "error"].includes(described.level), outcome);
  }
});
