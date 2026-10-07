import { fileURLToPath as processKitFilePath } from 'node:url';
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findSecret, promptOf } from "./secret-prompt-guard.mjs";

const GUARD = processKitFilePath(new URL("./secret-prompt-guard.mjs", import.meta.url));

// Built from fragments so no secret-shaped literal is ever committed.
const fakes = {
  "openai-anthropic-deepseek key": "s" + "k-ant-" + "Ab1".repeat(10),
  "xai key": "x" + "ai-" + "Ab1".repeat(10),
  "github token": "gh" + "p_" + "A1".repeat(18),
  "github fine-grained token": "github" + "_pat_" + "A1b".repeat(10),
  "posthog personal key": "ph" + "x_" + "Ab1".repeat(11),
  "aws access key": "AK" + "IA" + "ABCDEFGH12345678",
  "private key": "-----BEGIN " + "RSA PRIVATE KEY-----",
  "keyword + long token": "api_key" + "=" + "Zx9".repeat(12),
};

const run = (args, input) => spawnSync(process.execPath, [GUARD, ...args], { input, encoding: "utf8" });

for (const [kind, secret] of Object.entries(fakes)) {
  test(`blocks ${kind} without echoing it`, () => {
    const prompt = `вот ключ ${secret} проверь`;
    assert.equal(findSecret(prompt)?.kind, kind);
    const result = run([], JSON.stringify({ prompt }));
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Prompt blocked/);
    for (let i = 0; i + 8 <= secret.length; i += 1) {
      assert.ok(!result.stderr.includes(secret.slice(i, i + 8)), "stderr leaks part of the secret");
    }
  });
}

test("allows ordinary prompts with empty stdout", () => {
  const negatives = [
    "возьми op://agents/PLANE/credential и проверь",
    "commit 8ac907765aa1b2c3d4e5f60718293a4b5c6d7e8f",
    "id 3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0a3c",
    "use sk-... as a placeholder",
    "token: abc",
    "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkwYWJjZGVm",
    "phc_" + "Ab1".repeat(11) + " is the public project key",
    "Привет, сделай статус по задаче и покажи, что дальше.",
  ];
  for (const prompt of negatives) {
    assert.equal(findSecret(prompt), null, prompt);
    const result = run([], JSON.stringify({ prompt }));
    assert.equal(result.status, 0, prompt);
    assert.equal(result.stdout, "", prompt);
  }
});

test("reads the prompt from every known payload key", () => {
  for (const key of ["prompt", "userPrompt", "user_prompt", "message"]) {
    assert.equal(promptOf({ [key]: "x" }), "x");
  }
  assert.equal(promptOf({}), "");
});

test("fails open on malformed stdin", () => {
  const result = run([], "{not json");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("exec mode never spawns the child for a secret prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-exec-"));
  const marker = join(dir, "spawned");
  try {
    const child = ["--exec", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`];
    const result = run(child, JSON.stringify({ prompt: `x ${fakes["github token"]}` }));
    assert.equal(result.status, 2);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exec mode passes clean stdin through and returns the child's status", () => {
  const input = JSON.stringify({ prompt: "обычный промпт" });
  const echo = ["--exec", "--", process.execPath, "-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exitCode = 3)"];
  const result = run(echo, input);
  assert.equal(result.stdout, input);
  assert.equal(result.status, 3);
});

test("exec mode still runs the child on malformed stdin", () => {
  const echo = ["--exec", "--", process.execPath, "-e", "process.stdin.pipe(process.stdout)"];
  const result = run(echo, "{not json");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "{not json");
});
