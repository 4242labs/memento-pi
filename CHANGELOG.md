# Changelog

## [0.2.0](https://github.com/4242labs/memento-pi/compare/pi-memento-v0.1.1...pi-memento-v0.2.0) (2026-08-20)


### Features

* the lifecycle — journal, enqueue, and one bounded consolidation pass ([#3](https://github.com/4242labs/memento-pi/issues/3)) ([070ca5d](https://github.com/4242labs/memento-pi/commit/070ca5df6f154479b3980eaa43d5ecf9a1d63f8b))

## 0.1.1 (2026-08-14)

Nothing in the wrapper changed. npm snapshots the README at publish time, and the 0.1.0 page
still showed a front door that had already been fixed in the repository.

### Documentation

* repo-lifecycle canon: status and maintenance badges, `LICENSING.md`, the contribution
  licence grant, issue templates
* `LICENSING.md` states the thing that actually matters here — this wrapper is Apache-2.0
  while the engine it invokes is AGPL-3.0-only with a commercial option, and the boundary
  between them is a process boundary rather than a link
* no commercial-licence offer on this package — Apache-2.0 already grants what one would sell
* no "experimental" banner; "pre-v1", and the specific thing that is unfinished is that no
  live consolidation has run end to end

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
