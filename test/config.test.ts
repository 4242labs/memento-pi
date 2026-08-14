import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_RELATIVE, ConfigError, defaults, loadConfig } from "../src/config.ts";
import { distillPrompt, extractProposal, ProposalError } from "../src/proposal.ts";
import { scratch } from "./helpers.ts";

const write = (root: string, config: unknown) => {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, CONFIG_RELATIVE),
    typeof config === "string" ? config : JSON.stringify(config),
  );
};

test("a project with no config gets a store beside it", () => {
  const { path, cleanup } = scratch("config-default");
  try {
    const config = loadConfig(path);
    assert.deepEqual(config, defaults(path));
    assert.equal(config.store, join(path, "memento"));
    assert.equal(config.queue, join(path, "memento", ".queue"));
    assert.equal(config.minIdleSeconds, 5, "the contract's own default");
  } finally {
    cleanup();
  }
});

test("relative paths resolve against the project, absolute ones are left alone", () => {
  const { path, cleanup } = scratch("config-paths");
  try {
    write(path, { store: "./memory", adapterFile: "./adapter.json" });
    const relative = loadConfig(path);
    assert.equal(relative.store, join(path, "memory"));
    assert.equal(relative.queue, join(path, "memory", ".queue"));
    assert.equal(relative.adapterFile, join(path, "adapter.json"));

    write(path, { store: "/var/memento", queue: "/var/q" });
    const absolute = loadConfig(path);
    assert.equal(absolute.store, "/var/memento");
    assert.equal(absolute.queue, "/var/q");
  } finally {
    cleanup();
  }
});

test("an unknown field is refused, never ignored", () => {
  const { path, cleanup } = scratch("config-unknown");
  try {
    write(path, { store: "./m", adapterfile: "./a.json" });
    assert.throws(
      () => loadConfig(path),
      (e: unknown) =>
        e instanceof ConfigError && /unknown field "adapterfile"/.test((e as Error).message),
    );
  } finally {
    cleanup();
  }
});

test("malformed values are refused with the field named", () => {
  const { path, cleanup } = scratch("config-bad");
  try {
    for (const [config, message] of [
      ["{ not json", /not valid JSON/],
      [[], /must be a JSON object/],
      [{ store: "" }, /store must be a non-empty string/],
      [{ minIdleSeconds: -1 }, /minIdleSeconds must be a non-negative number/],
      [{ minIdleSeconds: "5" }, /minIdleSeconds must be a non-negative number/],
      [{ journalTurns: "yes" }, /journalTurns must be true or false/],
    ] as [unknown, RegExp][]) {
      write(path, config);
      assert.throws(() => loadConfig(path), message, JSON.stringify(config));
    }
  } finally {
    cleanup();
  }
});

test("a pinned engine commit is carried through to the startup assertion", () => {
  const { path, cleanup } = scratch("config-pin");
  try {
    write(path, { expectedRev: "02a31e8d1fdce1616bba3cfbca60f8af5eae8e4a" });
    assert.equal(loadConfig(path).expectedRev, "02a31e8d1fdce1616bba3cfbca60f8af5eae8e4a");
  } finally {
    cleanup();
  }
});

test("the distiller's proposal is the last fenced JSON object", () => {
  const reply = [
    "Here is a first thought:",
    "```json",
    '{"facts":{"draft":true}}',
    "```",
    "On reflection:",
    "```json",
    '{"facts":{"final":true}}',
    "```",
  ].join("\n");
  assert.deepEqual(extractProposal(reply), { facts: { final: true } });
});

test("prose instead of a proposal is an error, never an empty write", () => {
  assert.throws(() => extractProposal("I do not think anything should change."), ProposalError);
  assert.throws(
    () => extractProposal("```json\n[1,2,3]\n```"),
    ProposalError,
    "an array is not a proposal",
  );
});

test("the distiller is told the write is gated, and what it must never propose", () => {
  const prompt = distillPrompt({
    session: "s1",
    prefix: "current",
    turns: [{ text: "t" }],
    attempt: 1,
  });
  assert.match(prompt, /all-or-nothing/);
  assert.match(prompt, /Never propose a credential/);
  assert.match(prompt, /anti-erosion|erosion/);
  assert.doesNotMatch(prompt, /attempt 1/);

  const corrected = distillPrompt({
    session: "s1",
    prefix: "current",
    turns: [],
    violations: [{ rule: "schema" }],
    attempt: 2,
  });
  assert.match(corrected, /attempt 2/);
  assert.match(corrected, /The gates refused your last proposal/);
  assert.match(corrected, /only correction you get/);
});
