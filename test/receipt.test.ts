import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  describePin,
  parseReceipt,
  pinMatches,
  readEnginePin,
  receiptPath,
  uvToolDir,
} from "../src/receipt.ts";
import { scratch } from "./helpers.ts";

const RECEIPT = `[tool]
requirements = [{ name = "memento", git = "https://github.com/4242labs/memento?rev=02a31e8d1fdce1616bba3cfbca60f8af5eae8e4a" }]
entrypoints = [
    { name = "memento", install-path = "/Users/x/.local/bin/memento", from = "memento" },
]
`;

test("the pin is the git commit, read from the install receipt", () => {
  const pin = parseReceipt(RECEIPT);
  assert.equal(pin?.name, "memento");
  assert.equal(pin?.rev, "02a31e8d1fdce1616bba3cfbca60f8af5eae8e4a");
  assert.equal(pin?.git, "https://github.com/4242labs/memento");
});

test("an explicit rev key is read as well as one carried in the URL", () => {
  const pin = parseReceipt(
    '[tool]\nrequirements = [{ name = "memento", git = "https://example/repo", rev = "abcdef1234" }]\n',
  );
  assert.equal(pin?.rev, "abcdef1234");
});

test("a requirement for another tool is not this tool's provenance", () => {
  const pin = parseReceipt(
    '[tool]\nrequirements = [{ name = "something-else", git = "https://example/x?rev=deadbeef" }]\n',
  );
  assert.equal(pin, undefined);
});

test("a receipt with no git pin yields a name and no commit — never a guess", () => {
  const pin = parseReceipt(
    '[tool]\nrequirements = [{ name = "memento", specifier = "memento==0.1.0" }]\n',
  );
  assert.equal(pin?.name, "memento");
  assert.equal(pin?.rev, undefined);
  assert.match(describePin({ ...(pin as { name: string }), receipt: "/r" }), /provenance unknown/);
});

test("no receipt at all is reported as unknown provenance, not as fine", () => {
  const { path, cleanup } = scratch("receipt-missing");
  try {
    assert.equal(readEnginePin("memento", { UV_TOOL_DIR: path } as NodeJS.ProcessEnv), undefined);
    assert.match(describePin(undefined), /provenance unknown, not assumed/);
  } finally {
    cleanup();
  }
});

test("the receipt is found under the uv tool dir, honouring the environment", () => {
  assert.equal(uvToolDir({ UV_TOOL_DIR: "/custom" } as NodeJS.ProcessEnv), "/custom");
  assert.equal(
    uvToolDir({ XDG_DATA_HOME: "/data" } as NodeJS.ProcessEnv),
    join("/data", "uv", "tools"),
  );
  assert.equal(
    receiptPath("memento", { UV_TOOL_DIR: "/custom" } as NodeJS.ProcessEnv),
    join("/custom", "memento", "uv-receipt.toml"),
  );
});

test("a real receipt on disk reads end to end", () => {
  const { path, cleanup } = scratch("receipt");
  try {
    mkdirSync(join(path, "memento"), { recursive: true });
    writeFileSync(join(path, "memento", "uv-receipt.toml"), RECEIPT);
    const pin = readEnginePin("memento", { UV_TOOL_DIR: path } as NodeJS.ProcessEnv);
    assert.equal(pin?.rev, "02a31e8d1fdce1616bba3cfbca60f8af5eae8e4a");
    assert.match(describePin(pin), /4242labs\/memento@02a31e8d1fdc/);
  } finally {
    cleanup();
  }
});

test("a project that pins a commit only matches that commit", () => {
  const pin = { name: "memento", rev: "aaa", receipt: "/r" };
  assert.equal(pinMatches(pin, "aaa"), true);
  assert.equal(pinMatches(pin, "bbb"), false);
  assert.equal(pinMatches(undefined, "aaa"), false, "an untraceable engine never matches a pin");
  assert.equal(
    pinMatches(undefined, undefined),
    true,
    "a project that pins nothing accepts what is installed",
  );
  assert.equal(pinMatches({ name: "memento", receipt: "/r" }, "aaa"), false);
});
