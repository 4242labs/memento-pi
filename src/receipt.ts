import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Provenance comes from the install record, never from the CLI's own words. The engine is
 * installed from a git pin (`uv tool install "memento @ git+…@<sha>"`), and uv writes that
 * pin to a receipt. A binary that cannot be traced to a commit is reported as untraceable
 * rather than assumed current.
 */
export interface EnginePin {
  /** The tool as uv recorded it. */
  name: string;
  /** Repository URL from the pin, when the install was from git. */
  git?: string;
  /** The exact commit. This is the provenance. */
  rev?: string;
  /** Where the receipt was read from. */
  receipt: string;
}

export const uvToolDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.UV_TOOL_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "uv", "tools");

export const receiptPath = (tool = "memento", env?: NodeJS.ProcessEnv): string =>
  join(uvToolDir(env), tool, "uv-receipt.toml");

/**
 * The receipt is TOML, and one line of it matters. Rather than take a TOML dependency for a
 * single inline table, the requirement entry is read directly — and anything unrecognised
 * returns undefined instead of a guess.
 */
export function parseReceipt(
  toml: string,
  tool = "memento",
): Omit<EnginePin, "receipt"> | undefined {
  const requirements = /requirements\s*=\s*\[([\s\S]*?)\]/.exec(toml)?.[1];
  if (!requirements) return undefined;
  for (const entry of requirements.split("},")) {
    const name = /name\s*=\s*"([^"]+)"/.exec(entry)?.[1];
    if (name !== tool) continue;
    const url = /git\s*=\s*"([^"]+)"/.exec(entry)?.[1];
    const revFromUrl = url?.includes("?rev=") ? url.split("?rev=")[1] : undefined;
    const rev = /rev\s*=\s*"([^"]+)"/.exec(entry)?.[1] ?? revFromUrl;
    const git = url?.split("?")[0];
    return { name, ...(git ? { git } : {}), ...(rev ? { rev } : {}) };
  }
  return undefined;
}

export function readEnginePin(tool = "memento", env?: NodeJS.ProcessEnv): EnginePin | undefined {
  const path = receiptPath(tool, env);
  if (!existsSync(path)) return undefined;
  const parsed = parseReceipt(readFileSync(path, "utf8"), tool);
  return parsed ? { ...parsed, receipt: path } : undefined;
}

/** One line for the operator: what is installed, and whether it can be traced to a commit. */
export function describePin(pin: EnginePin | undefined): string {
  if (!pin) return "MEMENTO engine: no uv install receipt found — provenance unknown, not assumed.";
  if (!pin.rev)
    return `MEMENTO engine: installed as ${pin.name} without a git pin (${pin.receipt}) — provenance unknown.`;
  return `MEMENTO engine: ${pin.git ?? "git"}@${pin.rev.slice(0, 12)}`;
}

/** True only when the install is pinned to the commit the operator expects. */
export const pinMatches = (pin: EnginePin | undefined, expectedRev: string | undefined): boolean =>
  expectedRev === undefined || (pin?.rev !== undefined && pin.rev === expectedRev);
