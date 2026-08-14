import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Per-project configuration, read from `.pi/memento.json` when it is there and defaulted
 * when it is not. The store lives in the project and is gitignored by the operator: memory
 * about a project belongs beside it, and belongs to them.
 */
export interface MementoConfig {
  /** Absolute path to the store. */
  store: string;
  /** Absolute path to the queue. */
  queue: string;
  /** Adapter spec file, absolute, when the project declares one. */
  adapterFile?: string;
  /** How idle a session must be before this front-end will consider consolidating it. */
  minIdleSeconds: number;
  /** Journal every assistant turn, or only what the operator marks. */
  journalTurns: boolean;
  /** The engine commit this project expects, when it pins one. */
  expectedRev?: string;
  binary: string;
}

export const CONFIG_RELATIVE = join(".pi", "memento.json");

export class ConfigError extends Error {}

const abs = (root: string, path: string): string => (isAbsolute(path) ? path : resolve(root, path));

export function defaults(root: string): MementoConfig {
  const store = join(root, "memento");
  return {
    store,
    queue: join(store, ".queue"),
    minIdleSeconds: 5,
    journalTurns: true,
    binary: "memento",
  };
}

export function loadConfig(root: string): MementoConfig {
  const path = join(root, CONFIG_RELATIVE);
  const base = defaults(root);
  if (!existsSync(path)) return base;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`${path}: not valid JSON — ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path}: must be a JSON object`);
  }

  const known = new Set([
    "store",
    "queue",
    "adapterFile",
    "minIdleSeconds",
    "journalTurns",
    "expectedRev",
    "binary",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ConfigError(`${path}: unknown field "${key}"`);
  }

  const str = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.trim() === "")
      throw new ConfigError(`${path}: ${key} must be a non-empty string`);
    return v;
  };

  const store = str("store") ? abs(root, str("store") as string) : base.store;
  const queue = str("queue") ? abs(root, str("queue") as string) : join(store, ".queue");
  const adapterFile = str("adapterFile");
  const minIdle = raw.minIdleSeconds;
  if (
    minIdle !== undefined &&
    (typeof minIdle !== "number" || !Number.isFinite(minIdle) || minIdle < 0)
  ) {
    throw new ConfigError(`${path}: minIdleSeconds must be a non-negative number`);
  }
  if (raw.journalTurns !== undefined && typeof raw.journalTurns !== "boolean") {
    throw new ConfigError(`${path}: journalTurns must be true or false`);
  }

  return {
    store,
    queue,
    ...(adapterFile ? { adapterFile: abs(root, adapterFile) } : {}),
    minIdleSeconds: typeof minIdle === "number" ? minIdle : base.minIdleSeconds,
    journalTurns: typeof raw.journalTurns === "boolean" ? raw.journalTurns : base.journalTurns,
    ...(str("expectedRev") ? { expectedRev: str("expectedRev") as string } : {}),
    binary: str("binary") ?? base.binary,
  };
}
