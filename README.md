# @4242labs/pi-memento

MEMENTO for [Pi](https://github.com/earendil-works/pi-mono) — persistent memory for a Pi
session. Recall what matters at session start, journal decisions as they are made,
consolidate on exit so the next session starts where this one ended.

> **Status: experimental.** Scaffold only; the lifecycle is under construction.

## What it wraps

The [MEMENTO](https://github.com/4242labs/memento) engine — a file-backed memory store with
an explicit consolidation loop (gate-check → claim → read → distill → consolidate → commit
→ release). This package is a thin lifecycle wrapper: it owns *when* the loop runs inside a
Pi session, never *how* the store works.

The engine is a separate program, invoked as a subprocess through its `memento` CLI. It is
not bundled, linked, or vendored here.

## Install

```bash
pi install npm:@4242labs/pi-memento
```

Requires the MEMENTO CLI on `PATH`:

```bash
uv tool install git+https://github.com/4242labs/memento
```

## Requirements

- pi **0.84.1** or later
- MEMENTO engine **0.1.0** or later

## License

This wrapper is Apache-2.0 — see [LICENSE](LICENSE). The MEMENTO engine it invokes is
licensed separately (AGPL-3.0-only, commercial on request); installing it is your choice
and its terms are its own.
