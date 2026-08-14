/**
 * The typed surface over the MEMENTO CLI. Two things are contractual — the exit code and the
 * `--json` payload — and this module touches nothing else. Console prose is never read, never
 * matched, never surfaced as a reason: if the payload does not say it, this wrapper does not
 * claim it.
 */

/** The engine's exit codes, exhaustive per docs/agent-consumers.md. */
export const EXIT = {
  ok: 0,
  usage: 1,
  malformed: 2,
  gatesRejected: 3,
  secrets: 4,
  stale: 5,
  claimed: 6,
  gateRefuses: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliResult<T = Record<string, unknown>> {
  code: number;
  /** The payload's own `ok`, which agrees with the exit code by construction. */
  ok: boolean;
  payload: T | undefined;
  /** `.error` from the payload — never stderr prose. */
  error: string | undefined;
  /** Kept for the operator's log, never parsed. */
  stderr: string;
}

export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;

export interface CliOptions {
  /** Absolute path to the store. */
  store: string;
  /** Absolute path to the queue; defaults to `<store>/.queue`. */
  queue?: string;
  /** Adapter spec file. Agent consumers use `--adapter-file` only, never `--adapter`. */
  adapterFile?: string;
  binary?: string;
  exec: Exec;
  timeoutMs?: number;
}

const parsePayload = (stdout: string): Record<string, unknown> | undefined => {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // A payload that is not JSON is a payload this wrapper does not have.
    return undefined;
  }
};

export class MementoCli {
  private readonly o: CliOptions;

  constructor(options: CliOptions) {
    this.o = options;
  }

  get store(): string {
    return this.o.store;
  }

  get queue(): string {
    return this.o.queue ?? `${this.o.store}/.queue`;
  }

  /** Every invocation carries `--store` and `--json`; nothing here reads console text. */
  async run<T = Record<string, unknown>>(
    verb: string,
    args: string[] = [],
    options: { signal?: AbortSignal } = {},
  ): Promise<CliResult<T>> {
    const argv = ["--store", this.o.store, verb, ...args, "--json"];
    const r = await this.o.exec(this.o.binary ?? "memento", argv, {
      timeout: this.o.timeoutMs ?? 120_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const payload = parsePayload(r.stdout);
    const error = typeof payload?.error === "string" ? payload.error : undefined;
    return {
      code: r.killed ? 124 : r.code,
      ok: payload?.ok === true,
      payload: payload as T | undefined,
      error,
      stderr: r.stderr,
    };
  }

  private withAdapter(args: string[]): string[] {
    return this.o.adapterFile ? [...args, "--adapter-file", this.o.adapterFile] : args;
  }

  private withQueue(args: string[]): string[] {
    return [...args, "--queue", this.queue];
  }

  /** Append this turn's material. The pile a consolidation is later distilled from. */
  journal(session: string, text: string) {
    return this.run("journal", this.withQueue([session, "--text", text]));
  }

  showJournal(session: string) {
    return this.run<{ turns?: unknown[] }>("journal", this.withQueue([session, "--show"]));
  }

  /** Session exit, and nothing else. No distillation, no git, nothing slow. */
  enqueue(session: string) {
    return this.run("enqueue", this.withQueue([session]));
  }

  pending() {
    return this.run<PendingPayload>("pending", this.withQueue([]));
  }

  /** The mandatory gate check. Exit 7 means later, not louder. */
  gateCheck(idleSeconds: number, prefixMaterialized: boolean) {
    return this.run<PendingPayload>(
      "pending",
      this.withQueue([
        "--gate-check",
        "--idle-seconds",
        String(Math.floor(idleSeconds)),
        ...(prefixMaterialized ? ["--prefix-materialized"] : []),
      ]),
    );
  }

  claim(session: string, ttlSeconds?: number) {
    return this.run<{ token?: string }>("claim", [
      session,
      ...(ttlSeconds ? ["--ttl", String(ttlSeconds)] : []),
    ]);
  }

  release(session: string, token: string) {
    return this.run("release", [session, "--token", token]);
  }

  prefix() {
    return this.run<{ text?: string; tokens?: number; flags?: unknown }>(
      "prefix",
      this.withAdapter([]),
    );
  }

  fingerprint() {
    return this.run<{ fingerprint?: string }>("facts", this.withAdapter(["--fingerprint"]));
  }

  /** Always `--expect`. `--unchecked` is not reachable from this wrapper. */
  consolidate(session: string, proposalPath: string, expect: string) {
    return this.run<{ violations?: unknown[] }>(
      "consolidate",
      this.withAdapter(
        this.withQueue(["--proposal", proposalPath, "--session", session, "--expect", expect]),
      ),
    );
  }

  commit(session: string) {
    return this.run<{ sha?: string; pushed?: boolean }>("commit", ["--session", session]);
  }

  /** The marker, last — after the commit, never inside the consolidation. */
  done(session: string) {
    return this.run("done", this.withQueue([session]));
  }

  recall(query: string, options: { limit?: number; budget?: number; stream?: string } = {}) {
    return this.run<{ hits?: unknown[] }>(
      "recall",
      this.withAdapter([
        query,
        ...(options.limit ? ["--limit", String(options.limit)] : []),
        ...(options.budget ? ["--budget", String(options.budget)] : []),
        ...(options.stream ? ["--stream", options.stream] : []),
      ]),
    );
  }
}

export interface PendingEntry {
  session: string;
  enqueued_at: number;
  deferrals: number;
}

export interface PendingPayload {
  ok?: boolean;
  backlog?: {
    breached?: boolean;
    count?: number;
    message?: string | null;
    oldest_age_days?: number;
    reason?: string | null;
  };
  pending?: PendingEntry[];
  error?: string;
}
