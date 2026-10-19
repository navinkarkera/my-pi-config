import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitArgs } from "../git-command.mjs";

test("accepts arbitrary read, mutating, and remote subcommands", () => {
  assert.deepEqual(parseGitArgs("status -sb"), ["status", "-sb"]);
  assert.deepEqual(parseGitArgs("checkout main"), ["checkout", "main"]);
  assert.deepEqual(parseGitArgs("reset --hard HEAD~1"), ["reset", "--hard", "HEAD~1"]);
  assert.deepEqual(parseGitArgs("clean -fd"), ["clean", "-fd"]);
  assert.deepEqual(parseGitArgs("commit -m 'a message'"), ["commit", "-m", "a message"]);
  assert.deepEqual(parseGitArgs("push origin main"), ["push", "origin", "main"]);
  assert.deepEqual(parseGitArgs("config user.name 'Navin K'"), ["config", "user.name", "Navin K"]);
  assert.deepEqual(parseGitArgs("bisect start"), ["bisect", "start"]);
});

test("parses quotes, escapes, spaces, and empty quoted arguments", () => {
  assert.deepEqual(parseGitArgs('commit -m "fix: spaced message"'), ["commit", "-m", "fix: spaced message"]);
  assert.deepEqual(parseGitArgs("commit -m 'single quoted message'"), ["commit", "-m", "single quoted message"]);
  assert.deepEqual(parseGitArgs('commit -m "say \\"hi\\""'), ["commit", "-m", 'say "hi"']);
  assert.deepEqual(parseGitArgs("commit -m 'keep \\ backslash'"), ["commit", "-m", "keep \\ backslash"]);
  assert.deepEqual(parseGitArgs('commit --allow-empty -m ""'), ["commit", "--allow-empty", "-m", ""]);
  assert.deepEqual(parseGitArgs('commit -m "a" "b"'), ["commit", "-m", "a", "b"]);
});

test("keeps backslashes literal where POSIX does", () => {
  assert.deepEqual(parseGitArgs("commit -m a\\ b"), ["commit", "-m", "a b"]);
  assert.deepEqual(parseGitArgs('log --grep="v1\\.0"'), ["log", "--grep=v1\\.0"]);
  assert.deepEqual(parseGitArgs('commit -m "C:\\new\\dir"'), ["commit", "-m", "C:\\new\\dir"]);
  assert.deepEqual(parseGitArgs('commit -m "a\\nb"'), ["commit", "-m", "a\\nb"]);
  assert.deepEqual(parseGitArgs('commit -m "a\\\\b"'), ["commit", "-m", "a\\b"]);
  assert.deepEqual(parseGitArgs('commit -m "say \\"hi\\""'), ["commit", "-m", 'say "hi"']);
});

test("treats backslash-newline as POSIX line continuation", () => {
  assert.deepEqual(parseGitArgs('commit -m "line one\\\nline two"'), ["commit", "-m", "line oneline two"]);
  assert.deepEqual(parseGitArgs("commit -m one\\\ntwo"), ["commit", "-m", "onetwo"]);
});

test("keeps shell metacharacters literal", () => {
  assert.deepEqual(parseGitArgs("log --grep=a;b"), ["log", "--grep=a;b"]);
  assert.deepEqual(parseGitArgs("commit -m 'a && b | c > d < e'"), ["commit", "-m", "a && b | c > d < e"]);
  assert.deepEqual(parseGitArgs('commit -m "$(id) `id`"'), ["commit", "-m", "$(id) `id`"]);
});

test("rejects malformed input", () => {
  for (const command of ["", "   ", "commit -m 'unclosed", 'commit -m "unclosed', "commit -m trailing\\"]) {
    assert.equal(parseGitArgs(command), null, JSON.stringify(command));
  }
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(parseGitArgs(value), null, String(value));
  }
});

test("rejects global options before the subcommand", () => {
  for (const command of [
    "-c diff.external=/tmp/evil status",
    "--config-env=diff.external=HOOK status",
    "--no-pager log",
    "--version",
    "-",
  ]) {
    assert.equal(parseGitArgs(command), null, command);
  }
});
