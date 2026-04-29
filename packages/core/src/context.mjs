import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";

export const DEFAULT_MAX_FILES = 40;
export const DEFAULT_MAX_FILE_BYTES = 32768;
export const DEFAULT_IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);

export function splitCommaList(value) {
  if (value == null) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function collectContext({
  cwd,
  dirs = [],
  files = [],
  maxFiles = DEFAULT_MAX_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  allowOutsideWorkspace = false
} = {}) {
  validateLimits(maxFiles, maxFileBytes);

  const root = path.resolve(cwd ?? process.cwd());
  const rootForContainment = resolveRealPath(root);
  const candidatesByPath = new Map();
  const skippedFiles = [];

  const assertWithinRoot = (absolutePath, label) => {
    if (allowOutsideWorkspace) return;
    if (!isWithinRoot(rootForContainment, absolutePath)) {
      throw new Error(
        `Context path escapes workspace root: ${label} (resolved to ${absolutePath}). ` +
        `Pass allowOutsideWorkspace: true to opt in.`
      );
    }
  };

  for (const dir of dirs ?? []) {
    const absoluteDir = path.resolve(root, dir);
    assertWithinRoot(absoluteDir, dir);
    if (!fs.existsSync(absoluteDir)) {
      throw new Error(`Context directory does not exist: ${dir}`);
    }
    if (!fs.statSync(absoluteDir).isDirectory()) {
      throw new Error(`Context path is not a directory: ${dir}`);
    }
    for (const absolutePath of walkFiles(absoluteDir)) {
      candidatesByPath.set(resolveRealPath(absolutePath), absolutePath);
    }
  }

  const patterns = (files ?? []).map((pattern) => normalizePattern(root, pattern));
  if (patterns.length > 0) {
    for (const absolutePath of walkFiles(root)) {
      const relPath = toPosixRelative(root, absolutePath);
      if (patterns.some((pattern) => matchGlob(pattern, relPath))) {
        candidatesByPath.set(resolveRealPath(absolutePath), absolutePath);
      }
    }

    for (const pattern of patterns) {
      if (hasGlobMagic(pattern)) continue;
      const absolutePath = path.resolve(root, pattern);
      assertWithinRoot(absolutePath, pattern);
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        candidatesByPath.set(resolveRealPath(absolutePath), absolutePath);
      }
    }
  }

  const sortedCandidates = [...candidatesByPath.values()]
    .map((absolutePath) => ({
      absolutePath,
      path: toPosixRelative(root, absolutePath)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const textCandidates = [];
  for (const candidate of sortedCandidates) {
    const stat = fs.statSync(candidate.absolutePath);
    const sample = readFilePrefix(candidate.absolutePath, Math.min(stat.size, 4096));
    if (!isProbablyText(sample)) {
      skippedFiles.push({ path: candidate.path, reason: "binary", bytes: stat.size });
      continue;
    }
    textCandidates.push({ ...candidate, bytes: stat.size });
  }

  const includedCandidates = textCandidates.slice(0, maxFiles);
  for (const candidate of textCandidates.slice(maxFiles)) {
    skippedFiles.push({ path: candidate.path, reason: "over-limit", bytes: candidate.bytes });
  }

  const includedFiles = includedCandidates.map((candidate) => {
    const contentBuffer = readFilePrefix(candidate.absolutePath, Math.min(candidate.bytes, maxFileBytes));
    const truncated = candidate.bytes > maxFileBytes;
    const content = `${contentBuffer.toString("utf8")}${truncated ? "\n[truncated]" : ""}`;
    return {
      path: candidate.path,
      bytes: candidate.bytes,
      includedBytes: Buffer.byteLength(content, "utf8"),
      truncated,
      content
    };
  });

  const inventoryLines = includedFiles.map((file) =>
    `${file.path} (${file.bytes} bytes${file.truncated ? ", truncated" : ""})`
  );
  const promptBlock = buildPromptBlock(includedFiles);

  return {
    inventoryLines,
    promptBlock,
    includedFiles: includedFiles.map(({ content, ...file }) => file),
    skippedFiles
  };
}

function validateLimits(maxFiles, maxFileBytes) {
  if (!Number.isInteger(maxFiles) || maxFiles < 0) {
    throw new TypeError("maxFiles must be an integer greater than or equal to 0.");
  }
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new TypeError("maxFileBytes must be an integer greater than 0.");
  }
}

function* walkFiles(startDir) {
  for (const entry of fs.readdirSync(startDir, { withFileTypes: true })) {
    const absolutePath = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      yield* walkFiles(absolutePath);
    } else if (entry.isFile()) {
      yield absolutePath;
    }
  }
}

function resolveRealPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveExistingAncestor(filePath) {
  let current = path.resolve(filePath);
  const trailing = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(filePath);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithinRoot(rootRealpath, absolutePath) {
  const candidate = resolveExistingAncestor(absolutePath);
  if (candidate === rootRealpath) return true;
  const prefix = rootRealpath.endsWith(path.sep) ? rootRealpath : `${rootRealpath}${path.sep}`;
  return candidate.startsWith(prefix);
}

function readFilePrefix(filePath, byteLength) {
  if (byteLength <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(byteLength);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, byteLength, 0);
    return bytesRead === byteLength ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function toPosixRelative(root, absolutePath) {
  const relative = path.relative(root, absolutePath) || path.basename(absolutePath);
  return relative.split(path.sep).join("/");
}

function normalizePattern(root, pattern) {
  const raw = String(pattern ?? "").trim();
  const relative = path.isAbsolute(raw) ? path.relative(root, raw) : raw;
  return stripLeadingDot(relative.split(path.sep).join("/"));
}

function stripLeadingDot(value) {
  let next = value;
  while (next.startsWith("./")) {
    next = next.slice(2);
  }
  return next;
}

function hasGlobMagic(pattern) {
  return /[*?]/.test(pattern);
}

function matchGlob(pattern, relPath) {
  const patternSegments = stripLeadingDot(pattern).split("/").filter((segment) => segment.length > 0);
  const pathSegments = stripLeadingDot(relPath).split("/").filter((segment) => segment.length > 0);

  function matchFrom(patternIndex, pathIndex) {
    if (patternIndex === patternSegments.length) {
      return pathIndex === pathSegments.length;
    }

    const segment = patternSegments[patternIndex];
    if (segment === "**") {
      if (matchFrom(patternIndex + 1, pathIndex)) return true;
      return pathIndex < pathSegments.length && matchFrom(patternIndex, pathIndex + 1);
    }

    return (
      pathIndex < pathSegments.length &&
      matchSegment(segment, pathSegments[pathIndex]) &&
      matchFrom(patternIndex + 1, pathIndex + 1)
    );
  }

  return matchFrom(0, 0);
}

function matchSegment(pattern, value) {
  let regex = "";
  for (const character of pattern) {
    if (character === "*") regex += "[^/]*";
    else if (character === "?") regex += "[^/]";
    else regex += escapeRegex(character);
  }
  return new RegExp(`^${regex}$`).test(value);
}

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function buildPromptBlock(includedFiles) {
  const blocks = includedFiles.map((file) => `\`\`\`${file.path}\n${file.content}\n\`\`\``);
  return `## Context files\n\n${blocks.join("\n\n")}`;
}
