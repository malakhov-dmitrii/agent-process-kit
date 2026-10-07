import { fileURLToPath as processKitFilePath } from 'node:url';
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { replaceProfileFile } from "./profile-atomic-replace.mjs";

const DEFAULT_TRANSACTION_DIR = processKitFilePath(new URL("../transactions/profile-writes", import.meta.url));
const PENDING_KIND = "agent-harness-profile-write";
const PENDING_SCHEMA = 1;

export function profileHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function transactionDirectory(env = process.env) {
  return path.resolve(env.AGENT_HARNESS_PROFILE_TRANSACTION_DIR ?? DEFAULT_TRANSACTION_DIR);
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureTransactionDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Unsafe profile transaction directory: ${directory}`);
  }
  await chmod(directory, 0o700);
  await fsyncDirectory(path.dirname(directory));
}

async function writeAndSync(file, text, mode) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function replaceFileDurably(file, text, { mode, temporary } = {}) {
  const resolved = path.resolve(file);
  const targetMode = mode ?? ((await stat(resolved)).mode & 0o777);
  const next = temporary ?? path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.next`,
  );
  try {
    await writeAndSync(next, text, targetMode);
    await rename(next, resolved);
    await fsyncDirectory(path.dirname(resolved));
  } finally {
    await rm(next, { force: true });
  }
}

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function decode(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

function assertHash(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? "")) throw new Error(`Invalid pending ${label}`);
}

function validatePending(pending) {
  if (pending?.kind !== PENDING_KIND || pending.schemaVersion !== PENDING_SCHEMA) {
    throw new Error("Invalid profile transaction pending record");
  }
  for (const field of ["targetFile", "receiptFile", "targetTemporary"]) {
    if (typeof pending[field] !== "string" || !path.isAbsolute(pending[field])) {
      throw new Error(`Invalid pending ${field}`);
    }
  }
  if (pending.targetFile === pending.receiptFile) throw new Error("Pending receipt aliases its target");
  const targetPrefix = `.${path.basename(pending.targetFile)}.`;
  if (
    path.dirname(pending.targetTemporary) !== path.dirname(pending.targetFile)
    || !path.basename(pending.targetTemporary).startsWith(targetPrefix)
    || !pending.targetTemporary.endsWith(".next")
  ) {
    throw new Error("Invalid pending targetTemporary boundary");
  }
  assertHash(pending.preHash, "preHash");
  assertHash(pending.postHash, "postHash");
  if (!Number.isInteger(pending.ownerPid) || pending.ownerPid <= 0) throw new Error("Invalid pending ownerPid");
  if (!Number.isInteger(pending.targetMode) || pending.targetMode < 0 || pending.targetMode > 0o777) {
    throw new Error("Invalid pending targetMode");
  }
  const preimage = decode(pending.preimageBase64 ?? "");
  if (profileHash(preimage) !== pending.preHash) throw new Error("Pending preimage hash mismatch");
  const receiptText = decode(pending.receiptBase64 ?? "");
  const receipt = JSON.parse(receiptText);
  if (path.resolve(receipt.file) !== pending.targetFile) throw new Error("Pending receipt target mismatch");
  if (receipt.preHash !== pending.preHash || receipt.postHash !== pending.postHash) {
    throw new Error("Pending receipt hash mismatch");
  }
  return { preimage, receiptText };
}

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function removePending(pendingFile, pending) {
  await rm(pending.targetTemporary, { force: true });
  await rm(pendingFile, { force: true });
  await fsyncDirectory(path.dirname(pendingFile));
}

async function receiptMatches(pending, receiptText) {
  try {
    return await readFile(pending.receiptFile, "utf8") === receiptText;
  } catch {
    return false;
  }
}

async function finalizeReceipt(pending, receiptText) {
  await replaceFileDurably(pending.receiptFile, receiptText, { mode: 0o600 });
  if (!(await receiptMatches(pending, receiptText))) throw new Error("Receipt verification failed after finalization");
}

async function restorePreimage(pending, preimage) {
  await replaceProfileFile(pending.targetFile, Buffer.from(preimage), {
    expectedSha256: pending.postHash,
  });
  const restored = await readFile(pending.targetFile, "utf8");
  if (profileHash(restored) !== pending.preHash) throw new Error("Preimage verification failed after restore");
}

async function recoverPendingFile(pendingFile, { includeLiveOwner = false } = {}) {
  const metadata = await lstat(pendingFile);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Unsafe pending transaction file: ${pendingFile}`);
  const pending = JSON.parse(await readFile(pendingFile, "utf8"));
  const { preimage, receiptText } = validatePending(pending);
  if (!includeLiveOwner && processIsAlive(pending.ownerPid)) return { status: "live", pendingFile };

  const current = await readFile(pending.targetFile, "utf8");
  const currentHash = profileHash(current);
  if (currentHash === pending.preHash) {
    await removePending(pendingFile, pending);
    return { status: "discarded-before-apply", pendingFile };
  }
  if (currentHash !== pending.postHash) {
    throw new Error(`Pending profile transaction target drift: ${pending.targetFile}`);
  }

  try {
    if (!(await receiptMatches(pending, receiptText))) await finalizeReceipt(pending, receiptText);
    await removePending(pendingFile, pending);
    return { status: "finalized", pendingFile, receipt: pending.receiptFile };
  } catch (finalizeError) {
    try {
      await restorePreimage(pending, preimage);
      await removePending(pendingFile, pending);
    } catch (restoreError) {
      throw new AggregateError(
        [finalizeError, restoreError],
        `Pending profile transaction requires manual recovery: ${pendingFile}`,
      );
    }
    return { status: "restored-after-finalize-failure", pendingFile, error: finalizeError.message };
  }
}

export async function recoverProfileTransactions({ env = process.env } = {}) {
  const directory = transactionDirectory(env);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const results = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    results.push(await recoverPendingFile(path.join(directory, name)));
  }
  return results;
}

async function abortOwnTransaction(pendingFile, pending, phase, cause) {
  const { preimage } = validatePending(pending);
  const current = await readFile(pending.targetFile, "utf8");
  const currentHash = profileHash(current);
  if (currentHash === pending.preHash) {
    await removePending(pendingFile, pending);
    throw cause;
  }
  if (currentHash !== pending.postHash) {
    throw new AggregateError([cause], `Profile transaction target drift; recovery record retained: ${pendingFile}`);
  }
  try {
    await restorePreimage(pending, preimage);
    await removePending(pendingFile, pending);
  } catch (restoreError) {
    throw new AggregateError(
      [cause, restoreError],
      `Profile transaction recovery failed; pending record retained: ${pendingFile}`,
    );
  }
  const prefix = phase === "finalize-receipt"
    ? "Profile receipt finalization failed; target restored"
    : "Profile target write failed; target restored";
  throw new Error(`${prefix}: ${cause?.message ?? String(cause)}`, { cause });
}

export async function applyProfileTransaction({
  file,
  nextText,
  receiptFile,
  receipt,
  env = process.env,
  beforeInstall = null,
}) {
  const targetFile = path.resolve(file);
  const finalReceipt = path.resolve(receiptFile);
  if (targetFile === finalReceipt) throw new Error("Profile receipt must not alias its target");
  const current = await readFile(targetFile, "utf8");
  const metadata = await stat(targetFile);
  const preHash = profileHash(current);
  const postHash = profileHash(nextText);
  if (receipt.preHash !== preHash || receipt.postHash !== postHash) {
    throw new Error("Profile transaction receipt hashes do not match target contents");
  }
  if (path.resolve(receipt.file) !== targetFile) throw new Error("Profile transaction receipt target mismatch");

  const directory = transactionDirectory(env);
  await ensureTransactionDirectory(directory);
  const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const pendingFile = path.join(directory, `${id}.json`);
  const targetTemporary = path.join(path.dirname(targetFile), `.${path.basename(targetFile)}.${id}.next`);
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  const pending = {
    schemaVersion: PENDING_SCHEMA,
    kind: PENDING_KIND,
    id,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    targetFile,
    targetTemporary,
    receiptFile: finalReceipt,
    targetMode: metadata.mode & 0o777,
    preHash,
    postHash,
    preimageBase64: encode(current),
    receiptBase64: encode(receiptText),
  };
  await replaceFileDurably(pendingFile, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });

  let phase = "replace-target";
  try {
    await replaceProfileFile(targetFile, Buffer.from(nextText), {
      expectedSha256: preHash,
      beforeInstall,
    });
    const applied = await readFile(targetFile, "utf8");
    if (profileHash(applied) !== postHash) throw new Error("Target hash verification failed after replacement");
    if (env.AGENT_HARNESS_PROFILE_FAIL_AT === "after-target-before-finalize") process.exit(86);

    phase = "finalize-receipt";
    if (env.AGENT_HARNESS_PROFILE_FAIL_AT === "finalize-receipt") {
      throw new Error("Injected receipt finalization failure");
    }
    await finalizeReceipt(pending, receiptText);
    await removePending(pendingFile, pending);
  } catch (error) {
    if (await receiptMatches(pending, receiptText)) throw error;
    await abortOwnTransaction(pendingFile, pending, phase, error);
  }
}
