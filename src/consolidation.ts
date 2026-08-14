import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, type MementoCli } from "./cli.ts";

/**
 * One bounded consolidation pass, in the contract's order and no other:
 *
 *   gate-check → claim → reads → distill → consolidate --expect → commit → done → release
 *
 * The pass is bounded because the claim is: it is taken for ten minutes against a TTL of an
 * hour, and every path out of here releases it. An agent that walks away mid-loop leaves the
 * TTL as the recovery, but this one does not walk away.
 */

export const CLAIM_TTL_SECONDS = 3_600;
export const PASS_BUDGET_MS = 10 * 60_000;

export type PassOutcome =
  | "consolidated"
  | "gate-refused"
  | "claimed-elsewhere"
  | "nothing-pending"
  | "gates-rejected"
  | "malformed"
  | "secrets"
  | "stale"
  | "usage-error"
  | "release-failed"
  | "budget-exhausted";

export interface PassReport {
  outcome: PassOutcome;
  session?: string;
  /** What the engine said, from the payload — never console prose. */
  detail?: string;
  violations?: unknown[];
  /** `commit` result when the store opted into backup. */
  sha?: string;
  /** True when the claim came back cleanly. A false here is a FLAG, not a footnote. */
  released?: boolean;
  attempts: number;
}

/** The distiller is the caller: it reads the prefix and the journal and returns a proposal. */
export type Distiller = (input: {
  session: string;
  prefix: string;
  turns: unknown[];
  /** Set on a corrected resubmit — the gates' own reasons for refusing the last one. */
  violations?: unknown[];
  attempt: number;
}) => Promise<unknown | undefined>;

export interface PassOptions {
  cli: MementoCli;
  session: string;
  /** Seconds this session has been idle, observed — never invented to get past the gate. */
  idleSeconds: number;
  /**
   * Whether the read prefix was materialized in this session. Passing true without having
   * done it is the one thing the contract calls out by name, so it is the caller's word and
   * is never defaulted to true here.
   */
  prefixMaterialized: boolean;
  distill: Distiller;
  /** Wall clock for the whole pass. */
  budgetMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

const asViolations = (payload: { violations?: unknown[] } | undefined): unknown[] | undefined =>
  Array.isArray(payload?.violations) ? payload.violations : undefined;

export async function consolidateOnce(o: PassOptions): Promise<PassReport> {
  const now = o.now ?? Date.now;
  const deadline = now() + (o.budgetMs ?? PASS_BUDGET_MS);
  const spent = () => now() >= deadline;

  // 1. The gate check. Mandatory, and a refusal is obeyed — never worked around.
  const gate = await o.cli.gateCheck(o.idleSeconds, o.prefixMaterialized);
  if (gate.code === EXIT.gateRefuses) {
    return { outcome: "gate-refused", session: o.session, attempts: 0, ...detailOf(gate.error) };
  }
  if (gate.code !== EXIT.ok) {
    return {
      outcome: mapError(gate.code),
      session: o.session,
      attempts: 0,
      ...detailOf(gate.error),
    };
  }

  // 2. The claim. Someone else holding it is a skip, never a force.
  const claim = await o.cli.claim(o.session, CLAIM_TTL_SECONDS);
  if (claim.code === EXIT.claimed) {
    return {
      outcome: "claimed-elsewhere",
      session: o.session,
      attempts: 0,
      ...detailOf(claim.error),
    };
  }
  if (claim.code !== EXIT.ok || typeof claim.payload?.token !== "string") {
    return {
      outcome: mapError(claim.code),
      session: o.session,
      attempts: 0,
      ...detailOf(claim.error),
    };
  }
  const token = claim.payload.token;

  const finish = async (report: Omit<PassReport, "released">): Promise<PassReport> => {
    const release = await o.cli.release(o.session, token);
    return { ...report, released: release.code === EXIT.ok };
  };

  let attempts = 0;
  let violations: unknown[] | undefined;
  const scratch = mkdtempSync(join(tmpdir(), "pi-memento-"));

  try {
    // 3–5, with the two retries the contract allows and no others: one corrected resubmit
    // after a gate rejection, one redrive after a stale fingerprint.
    let corrections = 0;
    let redrives = 0;

    for (;;) {
      if (o.signal?.aborted)
        return await finish({ outcome: "budget-exhausted", session: o.session, attempts });
      if (spent())
        return await finish({ outcome: "budget-exhausted", session: o.session, attempts });

      // 3. Read: current state, raw material, and the compare-and-swap baseline.
      const prefix = await o.cli.prefix();
      if (prefix.code !== EXIT.ok) {
        return await finish({
          outcome: mapError(prefix.code),
          session: o.session,
          attempts,
          ...detailOf(prefix.error),
        });
      }
      const journal = await o.cli.showJournal(o.session);
      if (journal.code !== EXIT.ok) {
        return await finish({
          outcome: mapError(journal.code),
          session: o.session,
          attempts,
          ...detailOf(journal.error),
        });
      }
      const fingerprint = await o.cli.fingerprint();
      if (fingerprint.code !== EXIT.ok || typeof fingerprint.payload?.fingerprint !== "string") {
        return await finish({
          outcome: mapError(fingerprint.code),
          session: o.session,
          attempts,
          ...detailOf(fingerprint.error),
        });
      }

      // 4. Distill. This is the caller — the writer the gates were built to distrust.
      attempts += 1;
      const proposal = await o.distill({
        session: o.session,
        prefix: typeof prefix.payload?.text === "string" ? prefix.payload.text : "",
        turns: Array.isArray(journal.payload?.turns) ? journal.payload.turns : [],
        ...(violations ? { violations } : {}),
        attempt: attempts,
      });
      if (proposal === undefined) {
        return await finish({
          outcome: "nothing-pending",
          session: o.session,
          attempts,
          detail: "the distiller proposed nothing",
        });
      }

      const proposalPath = join(scratch, `proposal-${attempts}.json`);
      writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);

      // 5. Submit. Always with --expect; all-or-nothing.
      const submitted = await o.cli.consolidate(
        o.session,
        proposalPath,
        fingerprint.payload.fingerprint,
      );

      if (submitted.code === EXIT.gatesRejected) {
        violations = asViolations(submitted.payload);
        if (corrections >= 1) {
          return await finish({
            outcome: "gates-rejected",
            session: o.session,
            attempts,
            ...(violations ? { violations } : {}),
            ...detailOf(submitted.error),
          });
        }
        corrections += 1;
        continue; // one corrected resubmit, then out
      }

      if (submitted.code === EXIT.stale) {
        if (redrives >= 1) {
          return await finish({
            outcome: "stale",
            session: o.session,
            attempts,
            ...detailOf(submitted.error),
          });
        }
        redrives += 1;
        continue; // re-read and redrive once — a normal outcome, not an error
      }

      if (submitted.code === EXIT.secrets) {
        // Never retried, in any form. Removing it is the caller's problem, not a retry's.
        return await finish({
          outcome: "secrets",
          session: o.session,
          attempts,
          ...detailOf(submitted.error),
        });
      }

      if (submitted.code !== EXIT.ok) {
        return await finish({
          outcome: mapError(submitted.code),
          session: o.session,
          attempts,
          ...detailOf(submitted.error),
        });
      }

      // 6. Back it up, if this store opted in. A refusal here is reported, not fatal.
      const committed = await o.cli.commit(o.session);

      // 7. The marker, last.
      const marked = await o.cli.done(o.session);
      if (marked.code !== EXIT.ok) {
        return await finish({
          outcome: mapError(marked.code),
          session: o.session,
          attempts,
          ...detailOf(marked.error),
        });
      }

      return await finish({
        outcome: "consolidated",
        session: o.session,
        attempts,
        ...(typeof committed.payload?.sha === "string" ? { sha: committed.payload.sha } : {}),
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const detailOf = (error: string | undefined): { detail?: string } =>
  error ? { detail: error } : {};

const mapError = (code: number): PassOutcome => {
  switch (code) {
    case EXIT.malformed:
      return "malformed";
    case EXIT.gatesRejected:
      return "gates-rejected";
    case EXIT.secrets:
      return "secrets";
    case EXIT.stale:
      return "stale";
    case EXIT.claimed:
      return "claimed-elsewhere";
    case EXIT.gateRefuses:
      return "gate-refused";
    default:
      return "usage-error";
  }
};

/** What the operator is told. A backlog breach and a failed release are both FLAGs. */
export function describePass(report: PassReport): {
  text: string;
  level: "info" | "warning" | "error";
} {
  switch (report.outcome) {
    case "consolidated":
      return {
        text: `MEMENTO: consolidated ${report.session}${report.sha ? ` (backed up ${report.sha.slice(0, 12)})` : ""}${report.attempts > 1 ? ` after ${report.attempts} attempts` : ""}.`,
        level: "info",
      };
    case "gate-refused":
      return {
        text: `MEMENTO: not yet — the drain gate refused ${report.session}. It will be tried again later.`,
        level: "info",
      };
    case "claimed-elsewhere":
      return {
        text: `MEMENTO: ${report.session} is claimed by another front-end. Skipped.`,
        level: "info",
      };
    case "nothing-pending":
      return { text: "MEMENTO: nothing to consolidate.", level: "info" };
    case "stale":
      return {
        text: `MEMENTO: the store moved under ${report.session} twice. Left pending — it will be redriven.`,
        level: "warning",
      };
    case "gates-rejected":
      return {
        text: `MEMENTO: the gates refused the proposal for ${report.session} after a correction. Left pending.\n${JSON.stringify(report.violations ?? report.detail ?? "", null, 2)}`,
        level: "warning",
      };
    case "secrets":
      return {
        text: `MEMENTO: a credential-shaped string tried to enter the store from ${report.session}. Nothing was written, and this is not retried.`,
        level: "error",
      };
    case "malformed":
      return {
        text: `MEMENTO: the proposal for ${report.session} was not a JSON object. Nothing reached the gates.`,
        level: "error",
      };
    case "budget-exhausted":
      return {
        text: `MEMENTO: the consolidation pass for ${report.session} ran out of its bounded time and gave the claim back.`,
        level: "warning",
      };
    default:
      return {
        text: `MEMENTO: ${report.outcome} on ${report.session}${report.detail ? ` — ${report.detail}` : ""}.`,
        level: "error",
      };
  }
}
