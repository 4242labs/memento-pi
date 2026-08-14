# Changelog

## 0.1.0 (2026-08-14)

First release. Experimental: the lifecycle is wired and tested against a scripted engine, and
has not yet run a live consolidation end to end.

### Features

* provenance from the install receipt — the engine's identity is the git commit uv recorded,
  never the CLI's own words; a project that pins a commit and finds another refuses to run
* the contract read as a contract — exit codes and `--json` payloads only, never console prose
* one bounded consolidation pass in the engine's order: gate-check → claim → reads → distill →
  `consolidate --expect` → commit → done → release
* the claim always comes back — bounded at ten minutes against an hour TTL, released on every
  path out including aborts and spent budgets, and a refused release reported as a FLAG
* only the retries the contract allows — one corrected resubmit on exit 3 with the violations
  as the brief, one redrive on exit 5 against the new fingerprint, exit 4 never
* session exit does the cheap half: `enqueue`, no distillation, no git; journalled-but-never-
  enqueued sessions are recovered on the next start
* the host model as distiller, prompted with the prefix, the journal, and the gates' own
  violations on a correction
