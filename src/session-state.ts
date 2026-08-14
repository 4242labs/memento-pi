import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One record per front-end session, written beside the store. It exists for exactly one
 * reason: a crash between `journal` and `enqueue` must not lose the session. On the next
 * start, a record with journal material and no enqueue is enqueued **first**, before
 * anything else is considered.
 */
export interface SessionRecord {
  /** The MEMENTO session id this front-end minted. Persisted, never re-minted. */
  id: string;
  /** The host's own session id, so a resume finds its record again. */
  hostSessionId: string;
  journalCreated: boolean;
  enqueued: boolean;
  /** When the session ended, epoch ms. Absent while it is live. */
  endedAt?: number;
  startedAt: number;
}

export const stateDir = (store: string): string => join(store, ".pi-memento");

export const recordPath = (store: string, hostSessionId: string): string =>
  join(stateDir(store), `${hostSessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/**
 * `YYMMDD-HHMMSS`, the form the engine's own sessions use. Minted once and persisted: a
 * second mint would orphan the first session's journal.
 */
export function mintSessionId(at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(at.getFullYear() % 100)}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

export function readRecord(store: string, hostSessionId: string): SessionRecord | undefined {
  const path = recordPath(store, hostSessionId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
    return typeof parsed?.id === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeRecord(store: string, record: SessionRecord): SessionRecord {
  const path = recordPath(store, record.hostSessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** The session id for this host session: the persisted one, or a newly minted one. */
export function openSession(store: string, hostSessionId: string, at = new Date()): SessionRecord {
  const existing = readRecord(store, hostSessionId);
  if (existing) return existing;
  return writeRecord(store, {
    id: mintSessionId(at),
    hostSessionId,
    journalCreated: false,
    enqueued: false,
    startedAt: at.getTime(),
  });
}

export function markJournalled(store: string, record: SessionRecord): SessionRecord {
  return record.journalCreated ? record : writeRecord(store, { ...record, journalCreated: true });
}

export function markEnqueued(store: string, record: SessionRecord, at = Date.now()): SessionRecord {
  return writeRecord(store, { ...record, enqueued: true, endedAt: at });
}

export const allRecords = (store: string): SessionRecord[] => {
  const dir = stateDir(store);
  if (!existsSync(dir)) return [];
  const out: SessionRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as SessionRecord;
      if (typeof parsed?.id === "string") out.push(parsed);
    } catch {
      // A record this front-end cannot read is a record it does not act on.
    }
  }
  return out;
};

/**
 * Sessions this front-end journalled and never enqueued — the crash case. They are enqueued
 * before any consolidation is even considered, because material that was never enqueued is
 * material no consolidation will ever see.
 */
export const unenqueued = (store: string, exceptHostSession?: string): SessionRecord[] =>
  allRecords(store).filter(
    (r) => r.journalCreated && !r.enqueued && r.hostSessionId !== exceptHostSession,
  );

export const forgetRecord = (store: string, hostSessionId: string): void => {
  rmSync(recordPath(store, hostSessionId), { force: true });
};

/**
 * How long the session has been idle, in seconds. This front-end's own records are the
 * truth for its own sessions; for a session it never saw — another front-end's — the queue's
 * `enqueued_at` is what there is.
 */
export function idleSeconds(
  record: SessionRecord | undefined,
  enqueuedAt: number | undefined,
  atMs = Date.now(),
): number {
  const endedMs = record?.endedAt ?? (enqueuedAt !== undefined ? enqueuedAt * 1000 : undefined);
  if (endedMs === undefined) return 0;
  return Math.max(0, Math.floor((atMs - endedMs) / 1000));
}
