# Contributing

> [!IMPORTANT]
> **Pre-v1.** This package wraps a memory engine that gates every write. Its own surfaces —
> config shape, state records, the pass's outcomes — are not stable yet, and a change that
> breaks yours can land in a minor version.

## What this is, and what it is not

This is a **lifecycle wrapper**. It owns *when* the MEMENTO loop runs inside a Pi session and
nothing about how the store works. The engine is a separate program with its own gates, its
own compare-and-swap, and its own anti-erosion floor.

Two things in the engine's CLI are contractual — the **exit code** and the `--json` payload.
This wrapper reads those and nothing else. A patch that parses console prose will not land,
however well it works today: prose is explicitly not promised, and a consumer that depends on
it breaks on a wording change nobody thought was breaking.

## Rules a change is measured against

- **The gate check is mandatory.** Never pass `--prefix-materialized` that was not observed;
  never lower the idle bar to get past a refusal. Exit 7 means later, not louder.
- **Always `--expect`.** `--unchecked` is not reachable from this code and should stay that way.
- **The claim always comes back.** Every path out of a pass releases it, including aborts and
  spent budgets. A refused release is a FLAG, not a footnote.
- **Only the retries the contract allows:** one corrected resubmit on exit 3, one redrive on
  exit 5, and exit 4 never.
- **Session exit stays cheap.** `enqueue`, no distillation, no git. An exit that does real
  work is an exit the operator waits on.

## Working on it

```bash
npm ci
npm run check      # biome
npm run typecheck  # tsc
npm test           # the suite, against a scripted engine: every exit path, the verb order
npm run pack:check # what would ship to npm
```

The suite scripts the engine rather than mocking this package, so the order of the verbs and
the flags on each one are asserted against real invocations.

## Branches and commits

- **Work in a worktree**, never on the checkout of the integration branch. `.githooks/pre-commit`
  enforces it, reading `.repo-class` and `.integration-branch`; wire it with
  `git config core.hooksPath .githooks`.
- **Conventional Commits** — `release-please` builds the changelog and the version from them.
- **Every change lands through a pull request** with CI green.

## Licence of contributions

By submitting a pull request you agree that your contribution is licensed under the same
Apache-2.0 terms as the rest of the project, per section 5 of the licence itself. See
[LICENSING.md](LICENSING.md) — including why the engine this package invokes is licensed
differently.
