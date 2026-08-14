# Licensing

Copyright (c) 2026 42labs.

`@4242labs/pi-memento` is licensed under the [Apache License 2.0](LICENSE) —
permissive: use it, ship it, modify it, embed it in closed source, no copyleft
obligation and no separate commercial licence to buy.

That is a deliberate departure from the AGPL-3.0 the rest of 42labs publishes
under. This package is a **thin lifecycle wrapper an operator installs into their
own session** — a few hundred lines that decide *when* a loop runs. Attaching a
copyleft licence to the wrapper while the engine it calls carries its own would
put two sets of obligations on one install, for no gain to anybody.

`LICENSE` holds the verbatim Apache-2.0 text and nothing else, so that GitHub —
and every tool that reads a licence by matching it — identifies the project
correctly. Anything else about the terms lives here.

## The engine is licensed separately, and that matters here

This package **invokes the MEMENTO engine as a subprocess**. It does not bundle,
link, or vendor it. The engine is licensed **AGPL-3.0-only, commercial on
request** — <ahoy@42labs.io> — and installing it is a separate act with separate
terms:

```bash
uv tool install "memento @ git+https://github.com/4242labs/memento@<sha>"
```

Permissive here, copyleft there, and the boundary between them is a process
boundary rather than a link. Read the engine's terms before you depend on it in
a product.

## Contributions

By submitting a pull request you agree that your contribution is licensed under
the same Apache-2.0 terms as the rest of the project, per section 5 of the
licence itself.

## Pi

**Pi** (`@earendil-works/pi-coding-agent`), the harness this extends, carries its
own terms. They travel with it.
