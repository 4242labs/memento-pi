import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  allRecords,
  forgetRecord,
  idleSeconds,
  markEnqueued,
  markJournalled,
  mintSessionId,
  openSession,
  readRecord,
  recordPath,
  unenqueued,
} from "../src/session-state.ts";
import { scratch } from "./helpers.ts";

test("a session id is minted in the engine's own shape", () => {
  assert.equal(mintSessionId(new Date(2026, 7, 14, 9, 5, 3)), "260814-090503");
  assert.match(mintSessionId(new Date()), /^\d{6}-\d{6}$/);
});

test("the minted id is persisted, never minted twice for one host session", () => {
  const { path, cleanup } = scratch("state-id");
  try {
    const first = openSession(path, "host-1", new Date(2026, 7, 14, 9, 0, 0));
    const second = openSession(path, "host-1", new Date(2026, 7, 14, 10, 0, 0));
    assert.equal(second.id, first.id, "a second mint would orphan the first session's journal");
    assert.equal(readRecord(path, "host-1")?.id, first.id);
  } finally {
    cleanup();
  }
});

test("two host sessions keep separate ids and separate records", () => {
  const { path, cleanup } = scratch("state-separate");
  try {
    const a = openSession(path, "host-a", new Date(2026, 7, 14, 9, 0, 0));
    const b = openSession(path, "host-b", new Date(2026, 7, 14, 9, 0, 1));
    assert.notEqual(a.id, b.id);
    assert.equal(allRecords(path).length, 2);
    forgetRecord(path, "host-a");
    assert.deepEqual(
      allRecords(path).map((r) => r.hostSessionId),
      ["host-b"],
    );
  } finally {
    cleanup();
  }
});

test("a host session id with awkward characters still gets a file", () => {
  const { path, cleanup } = scratch("state-weird");
  try {
    const record = openSession(path, "../../etc/passwd");
    const file = recordPath(path, "../../etc/passwd");
    assert.ok(file.endsWith(".._.._etc_passwd.json"), file);
    assert.ok(file.startsWith(path), "a separator in the id never escapes the state directory");
    assert.equal(readRecord(path, "../../etc/passwd")?.id, record.id);
  } finally {
    cleanup();
  }
});

test("crash recovery: journalled but never enqueued is what gets picked up", () => {
  const { path, cleanup } = scratch("state-crash");
  try {
    const crashed = markJournalled(path, openSession(path, "host-crashed"));
    const clean = markEnqueued(path, markJournalled(path, openSession(path, "host-clean")));
    openSession(path, "host-quiet"); // never journalled: nothing to recover
    const current = openSession(path, "host-current");
    markJournalled(path, current);

    const orphans = unenqueued(path, "host-current");
    assert.deepEqual(
      orphans.map((r) => r.hostSessionId),
      ["host-crashed"],
    );
    assert.equal(orphans[0]?.id, crashed.id);
    assert.equal(clean.enqueued, true);
    assert.ok(clean.endedAt);
  } finally {
    cleanup();
  }
});

test("a corrupt record is ignored rather than acted on", () => {
  const { path, cleanup } = scratch("state-corrupt");
  try {
    openSession(path, "host-1");
    writeFileSync(recordPath(path, "host-1"), "{ truncated");
    assert.equal(readRecord(path, "host-1"), undefined);
    assert.deepEqual(allRecords(path), []);
  } finally {
    cleanup();
  }
});

test("idle time comes from our own record when we have one", () => {
  const record = {
    id: "260814-090000",
    hostSessionId: "h",
    journalCreated: true,
    enqueued: true,
    endedAt: 1_000_000,
    startedAt: 0,
  };
  assert.equal(idleSeconds(record, undefined, 1_000_000 + 90_000), 90);
});

test("for a foreign front-end's session, the queue's enqueued_at is what there is", () => {
  const enqueuedAt = 1_700_000_000; // seconds, as the payload reports it
  assert.equal(idleSeconds(undefined, enqueuedAt, (enqueuedAt + 300) * 1000), 300);
});

test("a session that has not ended is not idle at all", () => {
  const live = { id: "x", hostSessionId: "h", journalCreated: true, enqueued: false, startedAt: 0 };
  assert.equal(idleSeconds(live, undefined, Date.now()), 0);
  assert.equal(idleSeconds(undefined, undefined), 0);
});
