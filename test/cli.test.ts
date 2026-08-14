import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, MementoCli } from "../src/cli.ts";
import { fails, fakeEngine, ok } from "./helpers.ts";

const make = (script: Record<string, ReturnType<typeof ok>[]> = {}) => {
  const { exec, calls } = fakeEngine(script);
  return { cli: new MementoCli({ store: "/store", adapterFile: "/adapter.json", exec }), calls };
};

test("the queue defaults to the store's own .queue", () => {
  const { cli } = make();
  assert.equal(cli.queue, "/store/.queue");
  const { exec } = fakeEngine({});
  assert.equal(new MementoCli({ store: "/s", queue: "/elsewhere/q", exec }).queue, "/elsewhere/q");
});

test("the exit codes are the ones the engine documents", () => {
  assert.deepEqual(EXIT, {
    ok: 0,
    usage: 1,
    malformed: 2,
    gatesRejected: 3,
    secrets: 4,
    stale: 5,
    claimed: 6,
    gateRefuses: 7,
  });
});

test("the payload is the answer; `ok` and the exit code agree", async () => {
  const { cli } = make({ status: [ok({ documents: 3 })] });
  const r = await cli.run("status");
  assert.equal(r.code, 0);
  assert.equal(r.ok, true);
  assert.equal((r.payload as { documents?: number }).documents, 3);
  assert.equal(r.error, undefined);
});

test("an error is read from the payload, never from stderr prose", async () => {
  const { exec } = fakeEngine({
    consolidate: [
      { code: 3, payload: { ok: false, error: "gates refused" }, stderr: "some prose" },
    ],
  });
  const cli = new MementoCli({ store: "/s", exec });
  const r = await cli.consolidate("s1", "/p.json", "fp");
  assert.equal(r.code, EXIT.gatesRejected);
  assert.equal(r.error, "gates refused");
  assert.equal(r.stderr, "some prose", "kept for the log");
});

test("a payload that is not JSON leaves the wrapper with no payload, and no invention", async () => {
  const { exec } = fakeEngine({});
  const raw: typeof exec = async () => ({ stdout: "not json at all", stderr: "", code: 0 });
  const cli = new MementoCli({ store: "/s", exec: raw });
  const r = await cli.run("status");
  assert.equal(r.payload, undefined);
  assert.equal(r.ok, false, "no payload means no `ok`");
  assert.equal(r.error, undefined);
});

test("journal, enqueue, pending and done all carry the queue", async () => {
  const { cli, calls } = make();
  await cli.journal("s1", "what happened");
  await cli.enqueue("s1");
  await cli.pending();
  await cli.done("s1");
  for (const call of calls) {
    assert.ok(call.args.includes("--queue"), call.verb);
    assert.equal(call.args[call.args.indexOf("--queue") + 1], "/store/.queue");
  }
  const journal = calls[0];
  assert.equal(journal?.args[journal.args.indexOf("--text") + 1], "what happened");
});

test("the reads that need an adapter get one; the ones that do not, do not", async () => {
  const { cli, calls } = make();
  await cli.prefix();
  await cli.fingerprint();
  await cli.enqueue("s1");
  assert.ok(calls[0]?.args.includes("--adapter-file"));
  assert.ok(calls[1]?.args.includes("--fingerprint"));
  assert.ok(calls[1]?.args.includes("--adapter-file"));
  assert.equal(calls[2]?.args.includes("--adapter-file"), false);
});

test("the gate check passes what was observed and nothing more", async () => {
  const { cli, calls } = make();
  await cli.gateCheck(42.7, true);
  await cli.gateCheck(1, false);
  assert.equal(
    calls[0]?.args[calls[0].args.indexOf("--idle-seconds") + 1],
    "42",
    "seconds are whole",
  );
  assert.ok(calls[0]?.args.includes("--prefix-materialized"));
  assert.equal(calls[1]?.args.includes("--prefix-materialized"), false);
});

test("a killed invocation reads as 124, never as a pass", async () => {
  const cli = new MementoCli({
    store: "/s",
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: true }),
  });
  const r = await cli.run("status");
  assert.equal(r.code, 124);
  assert.equal(r.ok, false);
});

test("recall bounds both how many hits come back and what they cost", async () => {
  const { cli, calls } = make({ recall: [ok({ hits: [] })] });
  await cli.recall("kites", { limit: 8, budget: 400, stream: "vocab/fr" });
  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf("--limit") + 1], "8");
  assert.equal(args[args.indexOf("--budget") + 1], "400");
  assert.equal(args[args.indexOf("--stream") + 1], "vocab/fr");
});

test("an engine that exits 7 is reported as such rather than as a failure to run", async () => {
  const { cli } = make({ pending: [fails(7, "not yet")] });
  const r = await cli.gateCheck(1, false);
  assert.equal(r.code, EXIT.gateRefuses);
  assert.equal(r.error, "not yet");
});
