import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { profileHash, replaceFileDurably } from "./profile-write-transaction.mjs";

export async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await replaceFileDurably(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseLock(text, file) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    throw new Error(`Malformed harnessctl lock: ${file}`);
  }
  if (
    lock?.schemaVersion !== 1
    || lock.kind !== "harnessctl-lock"
    || !Number.isInteger(lock.pid)
    || lock.pid <= 0
    || typeof lock.profile !== "string"
    || lock.profile.length === 0
    || typeof lock.nonce !== "string"
    || lock.nonce.length === 0
    || typeof lock.startedAt !== "string"
  ) {
    throw new Error(`Malformed harnessctl lock: ${file}`);
  }
  return lock;
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

async function createExclusiveLock(file, text) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(file));
}

async function takeOverDeadLock(file, previousText, replacementText) {
  const claimed = `${file}.dead.${process.pid}.${randomUUID()}`;
  await rename(file, claimed);
  const claimedText = await readFile(claimed, "utf8");
  if (claimedText !== previousText) {
    if (!(await pathExists(file))) await rename(claimed, file);
    throw new Error(`Harnessctl lock changed during takeover: ${file}`);
  }
  try {
    await createExclusiveLock(file, replacementText);
  } catch (error) {
    if (!(await pathExists(file))) await rename(claimed, file);
    throw error?.code === "EEXIST"
      ? new Error(`Another harnessctl transaction acquired ${file}`)
      : error;
  } finally {
    await rm(claimed, { force: true });
  }
}

export async function acquireHarnessctlLock(file, profile) {
  if (!profile) throw new Error("Harnessctl lock profile is required");
  const record = {
    schemaVersion: 1,
    kind: "harnessctl-lock",
    pid: process.pid,
    profile,
    nonce: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const text = `${JSON.stringify(record)}\n`;
  try {
    await createExclusiveLock(file, text);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const previousText = await readFile(file, "utf8");
    const previous = parseLock(previousText, file);
    if (previous.profile !== profile) {
      throw new Error(`Harnessctl lock profile mismatch: expected ${profile}, found ${previous.profile}`);
    }
    if (processIsAlive(previous.pid)) throw new Error(`Harnessctl lock has a live owner: pid=${previous.pid}`);
    await takeOverDeadLock(file, previousText, text);
  }

  return async () => {
    let current;
    try {
      current = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (current !== text) throw new Error(`Harnessctl lock ownership changed: ${file}`);
    await rm(file);
    await fsyncDirectory(path.dirname(file));
  };
}

function validateBundle(bundle, bundlePath) {
  if (bundle?.kind !== "harnessctl-transaction" || bundle.schemaVersion !== 1) {
    throw new Error(`Not a harnessctl transaction receipt: ${bundlePath}`);
  }
  if (!Array.isArray(bundle.layers)) throw new Error(`Harnessctl bundle layers missing: ${bundlePath}`);
  if (bundle.status === "applying" && !Array.isArray(bundle.plannedLayers)) {
    throw new Error(`Harnessctl bundle plannedLayers missing: ${bundlePath}`);
  }
  if (bundle.plannedLayers !== undefined && !Array.isArray(bundle.plannedLayers)) {
    throw new Error(`Harnessctl bundle plannedLayers malformed: ${bundlePath}`);
  }
}

function validatePlan(plan, bundlePath) {
  for (const field of ["id", "host", "profile", "script", "file", "receipt", "preHash"]) {
    if (typeof plan?.[field] !== "string" || plan[field].length === 0) {
      throw new Error(`Harnessctl planned layer ${field} missing: ${bundlePath}`);
    }
  }
  if (!path.isAbsolute(plan.file) || !path.isAbsolute(plan.receipt) || !path.isAbsolute(plan.script)) {
    throw new Error(`Harnessctl planned layer paths must be absolute: ${bundlePath}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(plan.preHash)) throw new Error(`Harnessctl planned layer preHash invalid: ${plan.id}`);
}

async function readRecoveredLayer(plan) {
  const receiptText = await readFile(plan.receipt, "utf8");
  const receipt = JSON.parse(receiptText);
  if (receipt.schemaVersion !== 1) throw new Error(`Receipt schema mismatch for ${plan.id}`);
  const receiptHash = profileHash(receiptText);
  if (receipt.profile !== plan.profile) throw new Error(`Receipt profile mismatch for ${plan.id}`);
  if (path.resolve(receipt.file) !== path.resolve(plan.file)) throw new Error(`Receipt file mismatch for ${plan.id}`);
  if (receipt.preHash !== plan.preHash) throw new Error(`Receipt preHash mismatch for ${plan.id}`);
  const currentHash = profileHash(await readFile(plan.file, "utf8"));
  if (currentHash === plan.preHash && receipt.postHash !== plan.preHash) {
    return { restored: true, receipt, receiptHash };
  }
  if (receipt.postHash !== currentHash) throw new Error(`Receipt postHash mismatch for ${plan.id}`);
  return {
    restored: false,
    receipt,
    layer: {
      id: plan.id,
      host: plan.host,
      profile: plan.profile,
      script: plan.script,
      file: plan.file,
      receipt: plan.receipt,
      preHash: receipt.preHash,
      postHash: receipt.postHash,
      receiptHash,
      controllerState: receipt.codexTrust ? "codex-hook-trust" : undefined,
      output: { mode: "startup-recovered" },
    },
  };
}

export async function reconcileApplyingBundle(bundlePath, { recoveryResults = [] } = {}) {
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  validateBundle(bundle, bundlePath);
  if (bundle.status !== "applying") return bundle;
  const plans = bundle.plannedLayers ?? [];
  const layerIds = new Set(bundle.layers.map((layer) => layer.id));
  const recoveryByReceipt = new Map(
    recoveryResults.filter((result) => result.receipt).map((result) => [path.resolve(result.receipt), result.status]),
  );
  let changed = false;
  for (const plan of plans) {
    validatePlan(plan, bundlePath);
    if (layerIds.has(plan.id)) {
      const layer = bundle.layers.find((candidate) => candidate.id === plan.id);
      if (plan.status === "planned") {
        plan.status = "applied";
        changed = true;
      }
      if (plan.postHash !== layer.postHash || plan.receiptHash !== layer.receiptHash) {
        plan.postHash = layer.postHash;
        plan.receiptHash = layer.receiptHash;
        changed = true;
      }
      continue;
    }
    if (await pathExists(plan.receipt)) {
      const recovered = await readRecoveredLayer(plan);
      if (recovered.restored) {
        plan.status = "already-restored";
      } else {
        bundle.layers.push(recovered.layer);
        layerIds.add(plan.id);
        plan.status = "recovered";
      }
      plan.postHash = recovered.receipt.postHash;
      plan.receiptHash = recovered.receiptHash ?? recovered.layer.receiptHash;
      plan.recoveryStatus = recoveryByReceipt.get(path.resolve(plan.receipt)) ?? "receipt-found";
      changed = true;
      continue;
    }
    const currentHash = profileHash(await readFile(plan.file, "utf8"));
    if (currentHash !== plan.preHash) {
      throw new Error(`Unreceipted planned layer target drift: ${plan.id}`);
    }
  }
  if (changed) {
    bundle.reconciledAt = new Date().toISOString();
    await atomicWriteJson(bundlePath, bundle);
  }
  return bundle;
}

export async function reconcileApplyingBundles(receiptsDir, profile, options = {}) {
  let names;
  try {
    names = await readdir(receiptsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const matches = [];
  for (const name of names.filter((entry) => /^harnessctl-.*\.json$/u.test(entry)).sort()) {
    const bundlePath = path.join(receiptsDir, name);
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    if (bundle.kind !== "harnessctl-transaction" || bundle.status !== "applying") continue;
    if (bundle.requestedProfile !== profile) continue;
    matches.push({ path: bundlePath, bundle: await reconcileApplyingBundle(bundlePath, options) });
  }
  return matches;
}

export async function assertInterruptedPlansSafe(bundle) {
  const appliedIds = new Set((bundle.layers ?? []).map((layer) => layer.id));
  for (const plan of bundle.plannedLayers ?? []) {
    if (appliedIds.has(plan.id)) continue;
    const currentHash = profileHash(await readFile(plan.file, "utf8"));
    if (currentHash !== plan.preHash) throw new Error(`Interrupted layer is not rollback-safe: ${plan.id}`);
  }
}

async function latestBundle(receiptsDir, host) {
  const names = (await readdir(receiptsDir)).filter((name) => /^harnessctl-.*\.json$/u.test(name));
  const candidates = [];
  for (const name of names) {
    const file = path.join(receiptsDir, name);
    const [metadata, bundle] = await Promise.all([stat(file), readFile(file, "utf8").then(JSON.parse)]);
    if (!host || bundle.hosts?.includes(host)) candidates.push({ file, mtimeMs: metadata.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("No harnessctl receipt found");
  return candidates[0].file;
}

export async function harnessctlStatus({ receipt, receiptsDir, host }) {
  const receiptPath = receipt ?? await latestBundle(receiptsDir, host);
  const bundle = JSON.parse(await readFile(receiptPath, "utf8"));
  validateBundle(bundle, receiptPath);
  const expectedMode = bundle.status === "rolled-back" || bundle.status === "failed-rolled-back"
    ? "pre-apply"
    : "post-apply";
  const expectedByFile = new Map();
  for (const layer of bundle.layers) {
    if (layer.preHash === layer.postHash) continue;
    if (!expectedByFile.has(layer.file)) expectedByFile.set(layer.file, { pre: layer.preHash, post: layer.postHash });
    else expectedByFile.get(layer.file).post = layer.postHash;
  }
  const states = new Map();
  for (const [file, expected] of expectedByFile) {
    const current = profileHash(await readFile(file, "utf8"));
    const target = expectedMode === "pre-apply" ? expected.pre : expected.post;
    states.set(file, current === target ? expectedMode : "drifted");
  }
  return {
    receipt: receiptPath,
    id: bundle.id,
    status: bundle.status,
    profile: bundle.requestedProfile,
    hosts: bundle.hosts,
    layers: bundle.layers.map((layer) => ({
      id: layer.id,
      host: layer.host,
      file: layer.file,
      state: layer.preHash === layer.postHash ? "no-op" : states.get(layer.file),
    })),
    skipped: bundle.skipped ?? [],
  };
}
