#!/usr/bin/env node
import { isMain } from './entrypoint.mjs';
// UserPromptSubmit guard for Claude, Codex and Grok: blocks a prompt that carries a secret.
// Exit 2 + one stderr line blocks on all three hosts. Allow = exit 0 with empty stdout
// (Claude and Codex add hook stdout to the context). Any internal error fails open.
// `--exec -- <cmd…>` wraps another prompt hook: a blocked prompt never reaches it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["openai-anthropic-deepseek key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["xai key", /\bxai-[A-Za-z0-9]{20,}/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["github fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  // ponytail: phc_ project keys are public by design, only personal phx_ keys are secret.
  ["posthog personal key", /\bphx_[A-Za-z0-9]{30,}/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const KEYWORD = /(api[_ -]?key|token|secret|password|пароль|ключ|bearer)\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{32,})/gi;

export function findSecret(text) {
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { kind, offset: match.index };
  }
  for (const match of text.matchAll(KEYWORD)) {
    const token = match[2];
    if (/[A-Za-z]/.test(token) && /\d/.test(token)) return { kind: "keyword + long token", offset: match.index };
  }
  return null;
}

export function promptOf(payload) {
  for (const key of ["prompt", "userPrompt", "user_prompt", "message"]) {
    if (typeof payload?.[key] === "string") return payload[key];
  }
  return "";
}

function scan(stdinText) {
  try {
    return findSecret(promptOf(JSON.parse(stdinText)));
  } catch {
    return null;
  }
}

export function main(argv = process.argv.slice(2)) {
  let stdinText = "";
  try {
    stdinText = readFileSync(0, "utf8");
  } catch {}
  const hit = scan(stdinText);
  if (hit) {
    process.stderr.write(
      `Prompt blocked: possible secret (${hit.kind}, offset ${hit.offset}). Store credentials through your approved secret manager and share only a reference, never the value.\n`,
    );
    process.exitCode = 2; // not process.exit: stderr to a pipe is async on macOS and could be cut
    return;
  }
  const execAt = argv.indexOf("--exec");
  if (execAt < 0) return;
  const [command, ...args] = argv.slice(argv[execAt + 1] === "--" ? execAt + 2 : execAt + 1);
  if (!command) return;
  const child = spawnSync(command, args, { input: stdinText, stdio: ["pipe", "inherit", "inherit"] });
  process.exitCode = child.status ?? 0;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch {
    process.exitCode = 0;
  }
}
