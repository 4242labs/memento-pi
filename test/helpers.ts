import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../src/cli.ts";

/** Scratch lives inside the repo — nothing is written outside it. */
export function scratch(prefix: string): { path: string; cleanup: () => void } {
  const base = join(process.cwd(), ".tmp-test");
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, `${prefix}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export interface Call {
  command: string;
  args: string[];
  /** The verb, i.e. the argument after `--store <path>`. */
  verb: string;
}

export interface Reply {
  code: number;
  payload?: unknown;
  stderr?: string;
}

/**
 * A scripted engine. Replies are keyed by verb and consumed in order, so a test can say
 * "consolidate refuses once, then accepts" without touching a process.
 */
export function fakeEngine(script: Record<string, Reply[]>): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const queues: Record<string, Reply[]> = Object.fromEntries(
    Object.entries(script).map(([verb, replies]) => [verb, [...replies]]),
  );

  const exec: Exec = async (command, args) => {
    const verb = args[2] ?? "";
    calls.push({ command, args, verb });
    const next = queues[verb]?.shift() ?? { code: 0, payload: { ok: true } };
    return {
      stdout: next.payload === undefined ? "" : JSON.stringify(next.payload),
      stderr: next.stderr ?? "",
      code: next.code,
    };
  };

  return { exec, calls };
}

export const ok = (payload: Record<string, unknown> = {}): Reply => ({
  code: 0,
  payload: { ok: true, ...payload },
});
export const fails = (code: number, error?: string): Reply => ({
  code,
  payload: { ok: false, ...(error ? { error } : {}) },
});
