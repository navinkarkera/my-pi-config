import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSafeGitArgs } from "../git-command.mjs";

test("accepts safe read-only Git commands", () => {
  assert.deepEqual(parseSafeGitArgs("status -sb"), ["status", "-sb"]);
  assert.deepEqual(parseSafeGitArgs("diff -- src/file.ts"), ["diff", "--", "src/file.ts"]);
  assert.deepEqual(parseSafeGitArgs("branch --list"), ["branch", "--list"]);
  assert.deepEqual(parseSafeGitArgs("remote -v"), ["remote", "-v"]);
  assert.deepEqual(parseSafeGitArgs("tag -l"), ["tag", "-l"]);
});

test("rejects shell syntax and line breaks", () => {
  for (const command of ["", "status; id", "status && id", "status $(id)", "status\nid"]) {
    assert.equal(parseSafeGitArgs(command), null, command);
  }
});

test("rejects Git global config overrides and write-capable options", () => {
  for (const command of [
    "-c diff.external=/tmp/evil status",
    "--config-env=diff.external=HOOK status",
    "status --output=/tmp/out",
    "blame --output=/tmp/out",
    "log --open-files-in-pager",
  ]) {
    assert.equal(parseSafeGitArgs(command), null, command);
  }
});

test("rejects mutating Git forms and output helpers", () => {
  for (const command of [
    "checkout main",
    "branch -D main",
    "branch feature",
    "remote remove origin",
    "tag -d v1",
    "diff --output=/tmp/out",
    "show -o /tmp/out",
    "log --ext-diff",
    "show --textconv",
    "grep --open-files-in-pager",
  ]) {
    assert.equal(parseSafeGitArgs(command), null, command);
  }
});
