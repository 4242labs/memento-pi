# @4242labs/pi-memento

[![Project Status: WIP](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![Maintenance](https://img.shields.io/badge/maintenance-passively--maintained-yellowgreen.svg)](CONTRIBUTING.md)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@4242labs/pi-memento)](https://www.npmjs.com/package/@4242labs/pi-memento)

MEMENTO for [Pi](https://github.com/earendil-works/pi-mono) — persistent memory for a Pi
session. Recall what matters at session start, journal decisions as they are made,
consolidate later so the next session starts where this one ended.

> **Pre-v1.** The lifecycle is wired and tested against a scripted engine. It has not yet run a
> live consolidation end to end — that is the specific thing still missing.

## What it wraps

The [MEMENTO](https://github.com/4242labs/memento) engine — a file-backed memory store with
an explicit consolidation loop. This package is a thin lifecycle wrapper: it owns *when* the
loop runs inside a Pi session, never *how* the store works. The engine is a separate
program, invoked as a subprocess through its `memento` CLI. It is not bundled, linked, or
vendored here.

Two things in that CLI are contractual — the **exit code** and the `--json` **payload** — and
this wrapper reads nothing else. Console prose is never parsed, never matched, and never
surfaced as a reason.

## The lifecycle

| When | What happens |
|:--|:--|
| session start | provenance check → crash recovery → read the prefix |
| first request | the prefix is injected in front of the conversation |
| during | `/memento journal <text>` appends to this session's pile |
| `/memento consolidate` | one bounded pass over the oldest pending session |
| session exit | `enqueue`, and nothing else — no distillation, no git |

Session exit is deliberately the cheap half. An exit that does real work is an exit the
operator waits on.

### The consolidation pass

In the engine's order, and no other:

```
gate-check → claim → prefix + journal + fingerprint → distill → consolidate --expect
           → commit → done → release
```

- **The gate check is mandatory.** Exit 7 means later, not louder. The wrapper never passes
  `--prefix-materialized` it did not observe, and never lowers the idle bar to get past a
  refusal.
- **The compare-and-swap is not optional.** Every submission carries `--expect`;
  `--unchecked` is not reachable from this wrapper at all.
- **The claim always comes back.** The pass is bounded at ten minutes against a TTL of an
  hour, and every exit path releases. A release that is refused is reported as a FLAG, never
  swallowed.
- **The marker is last** — after the commit, so a crash between them loses the marker (cheap
  to redo) rather than the backup (not).

### What each exit code does

| Code | Meaning | This wrapper |
|:--|:--|:--|
| 0 | fine | continue |
| 1 | usage / IO | surface it; never retry blind |
| 2 | malformed | report — it never reached the gates |
| 3 | gates rejected | **one** corrected resubmit with the violations as the brief, then leave it pending |
| 4 | secrets | never retried, in any form |
| 5 | stale | re-read and redrive **once** against the new fingerprint |
| 6 | claimed | skip it; another front-end holds it |
| 7 | gate refuses | come back later |

### Who distils

You do — the host session's own model. It is handed the current prefix, this session's
journal, and (on a correction) the gates' own violations, and it replies with a proposal.
That makes it precisely the writer the gates were built to distrust, which is why the
compare-and-swap and the anti-erosion floor apply to it exactly as they do to anyone else.

## Provenance

The engine is installed from a git pin, and the pin is where its identity comes from:

```bash
uv tool install "memento @ git+https://github.com/4242labs/memento@<sha>"
```

At session start the wrapper reads uv's own install receipt and reports the commit. If your
project pins `expectedRev` and the installed engine is a different commit — or cannot be
traced to one at all — the wrapper refuses to consolidate rather than gating your memory
with an engine you did not ask for.

## Configuration

`.pi/memento.json`, all optional:

```json
{
  "store": "./memento",
  "queue": "./memento/.queue",
  "adapterFile": "./adapter.json",
  "minIdleSeconds": 5,
  "journalTurns": true,
  "expectedRev": "264564058c255ce5b5cef72bfc18063459cf7abc",
  "binary": "memento"
}
```

An unknown field is refused, never ignored: a typo must not silently disable the thing it
was meant to declare. Gitignore the store — it is your memory, not the repository's.

## Install

```bash
pi install npm:@4242labs/pi-memento
```

Requires the MEMENTO CLI on `PATH` (see Provenance above).

## As a library

The same code is importable, for a supervisor that wants the loop without the Pi extension:

```ts
import { MementoCli, consolidateOnce } from "@4242labs/pi-memento";
```

## Requirements

- pi **0.84.1** or later
- MEMENTO engine **0.1.0** or later

## The engine's own terms

The MEMENTO engine this wrapper invokes is licensed separately (AGPL-3.0-only, commercial on
request). Installing it is your choice and its terms are its own; this package is the wrapper
only.

## License

Open source — [Apache-2.0](LICENSE).

---
If it earned its keep, [coffee is appreciated](https://buymeacoffee.com/42piratas). ☕
