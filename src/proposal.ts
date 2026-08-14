/**
 * Reading the model's proposal back. The distiller in this front-end is the host session's
 * own model, so the proposal arrives as text and has to be recovered from it — the last
 * fenced JSON object wins, and prose instead of one is an error rather than an empty write.
 */

export class ProposalError extends Error {}

export function extractProposal(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const candidate of [...fenced.reverse(), text]) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // next candidate
    }
  }
  throw new ProposalError("no JSON object found in the distiller's reply");
}

/**
 * The brief the host model distils from. It states the compare-and-swap, the all-or-nothing
 * submission, and the gates — because a distiller that does not know its write is gated will
 * write as though it is not.
 */
export function distillPrompt(input: {
  session: string;
  prefix: string;
  turns: unknown[];
  violations?: unknown[];
  attempt: number;
}): string {
  return [
    `MEMENTO consolidation — session ${input.session}${input.attempt > 1 ? ` (attempt ${input.attempt})` : ""}.`,
    "",
    "You are the distiller. Read the current memory and this session's raw material, and propose what memory should become.",
    "",
    "## Current memory (the projected prefix)",
    input.prefix.trim() === "" ? "(the store is empty)" : input.prefix,
    "",
    "## This session's journal",
    input.turns.length === 0 ? "(no turns were journalled)" : JSON.stringify(input.turns, null, 2),
    ...(input.violations && input.violations.length > 0
      ? [
          "",
          "## The gates refused your last proposal",
          JSON.stringify(input.violations, null, 2),
          "",
          "Fix exactly that. This is the only correction you get before the session is left pending.",
        ]
      : []),
    "",
    "## Rules",
    "- The submission is all-or-nothing and goes through the engine's gates: anti-erosion, schema, secrets.",
    "- Never propose a credential, token, key, or anything shaped like one. That is refused and never retried.",
    "- Drop something only deliberately — the floor treats an unexplained disappearance as erosion.",
    "- Propose what is durably true, not what merely happened. A journal entry is not a fact.",
    "",
    "Reply with a single fenced JSON object — the proposal, and nothing after it:",
    "```json",
    '{ "…": "the proposal, in the shape this store\'s adapter declares" }',
    "```",
  ].join("\n");
}
