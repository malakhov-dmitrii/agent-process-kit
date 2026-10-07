import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rmdir,
  unlink,
  rename,
} from "node:fs/promises";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function metadata(metadata) {
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode: metadata.mode & 0o7777,
    uid: String(metadata.uid),
    gid: String(metadata.gid),
  };
}

function sameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function sameOwnershipMode(left, right) {
  return left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSnapshot(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`profile replace target is not a regular file: ${file}`);
  }
  const content = await readFile(file);
  const after = await lstat(file);
  const beforeMetadata = metadata(before);
  const afterMetadata = metadata(after);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || !sameIdentity(beforeMetadata, afterMetadata)
    || !sameOwnershipMode(beforeMetadata, afterMetadata)
  ) {
    throw new Error(`profile replace target drift: ${file}`);
  }
  return { content, sha256: sha256(content), ...afterMetadata };
}

export async function replaceProfileFile(file, content, {
  expectedSha256,
  nonce = () => randomUUID(),
  beforeInstall = null,
} = {}) {
  const parent = path.dirname(file);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error(`profile replace parent is not trusted: ${parent}`);
  }
  const parentRealpath = await realpath(parent);
  const target = path.join(parentRealpath, path.basename(file));
  const original = await readSnapshot(target);
  if (original.sha256 !== expectedSha256) {
    throw new Error(`profile replace target drift: ${file}`);
  }

  const stageRoot = await mkdtemp(
    path.join(parentRealpath, `.${path.basename(file)}.profile-replace-${await nonce()}-`),
  );
  await chmod(stageRoot, 0o700);
  const replacement = path.join(stageRoot, "replacement");
  const stagedOriginal = path.join(stageRoot, "original");
  let handle;
  let replacementCreated = false;
  let originalStaged = false;
  try {
    handle = await open(
      replacement,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      original.mode & 0o777,
    );
    replacementCreated = true;
    await handle.writeFile(content);
    await handle.chmod(original.mode);
    await handle.sync();
    const replacementMetadata = metadata(await handle.stat());
    if (!sameOwnershipMode(replacementMetadata, original)) {
      throw new Error(`profile replacement metadata mismatch: ${file}`);
    }
    await handle.close();
    handle = null;

    await rename(target, stagedOriginal);
    originalStaged = true;
    await syncDirectory(parentRealpath);
    const staged = await readSnapshot(stagedOriginal);
    if (!sameIdentity(staged, original) || staged.sha256 !== expectedSha256) {
      throw new Error(`profile replace target drift: ${file}`);
    }
    if (!sameOwnershipMode(staged, original)) {
      throw new Error(`profile replace target metadata drift: ${file}`);
    }

    await beforeInstall?.({ stagedFile: stagedOriginal, target });
    await link(replacement, target);
    await unlink(replacement);
    replacementCreated = false;
    await unlink(stagedOriginal);
    originalStaged = false;
    await rmdir(stageRoot);
    await syncDirectory(parentRealpath);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (replacementCreated) await unlink(replacement).catch(() => {});
    if (originalStaged) {
      try {
        await link(stagedOriginal, target);
        await unlink(stagedOriginal);
        originalStaged = false;
        await rmdir(stageRoot);
      } catch (restoreError) {
        error.preservedAt = stagedOriginal;
        error.message = `${error.message}; staged object preserved at ${stagedOriginal}`;
        if (restoreError?.code !== "EEXIST") error.cause = restoreError;
      }
    } else {
      await rmdir(stageRoot).catch(() => {});
    }
    await syncDirectory(parentRealpath).catch(() => {});
    throw error;
  }
}
