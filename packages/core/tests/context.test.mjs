import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectContext, splitCommaList } from "@ai-plugins-cc/core/context";

function makeTempTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gemini-context-test-"));
}

function writeText(root, relPath, content) {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function writeBuffer(root, relPath, content) {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function includedPaths(result) {
  return result.includedFiles.map((file) => file.path);
}

test("collectContext recursively walks directories, skips ignored dirs, and sorts alphabetically", () => {
  const cwd = makeTempTree();
  writeText(cwd, "zeta.txt", "z\n");
  writeText(cwd, "alpha/nested.txt", "a\n");
  writeText(cwd, "node_modules/foo.js", "ignored\n");

  const result = collectContext({ cwd, dirs: ["."], maxFiles: 40, maxFileBytes: 32768 });

  assert.deepEqual(includedPaths(result), ["alpha/nested.txt", "zeta.txt"]);
  assert.match(result.promptBlock, /alpha\/nested\.txt/);
  assert.doesNotMatch(result.promptBlock, /node_modules\/foo\.js/);
});

test("collectContext skips binary files with reason binary", () => {
  const cwd = makeTempTree();
  writeText(cwd, "text.txt", "hello\n");
  writeBuffer(cwd, "image.bin", Buffer.from([0x66, 0x00, 0x67]));

  const result = collectContext({ cwd, dirs: ["."], maxFiles: 40, maxFileBytes: 32768 });

  assert.deepEqual(includedPaths(result), ["text.txt"]);
  assert.deepEqual(result.skippedFiles.map((file) => [file.path, file.reason]), [["image.bin", "binary"]]);
});

test("collectContext dedupes overlapping directory and file matches by absolute path", () => {
  const cwd = makeTempTree();
  writeText(cwd, "shared.txt", "same\n");

  const result = collectContext({ cwd, dirs: ["."], files: ["shared.txt"], maxFiles: 40, maxFileBytes: 32768 });

  assert.deepEqual(includedPaths(result), ["shared.txt"]);
});

test("collectContext moves maxFiles overflow into skippedFiles with reason over-limit", () => {
  const cwd = makeTempTree();
  writeText(cwd, "a.txt", "a\n");
  writeText(cwd, "b.txt", "b\n");
  writeText(cwd, "c.txt", "c\n");

  const result = collectContext({ cwd, dirs: ["."], maxFiles: 2, maxFileBytes: 32768 });

  assert.deepEqual(includedPaths(result), ["a.txt", "b.txt"]);
  assert.deepEqual(result.skippedFiles.map((file) => [file.path, file.reason]), [["c.txt", "over-limit"]]);
});

test("collectContext truncates files over maxFileBytes and appends a marker", () => {
  const cwd = makeTempTree();
  writeText(cwd, "long.txt", "abcdef");

  const result = collectContext({ cwd, dirs: ["."], maxFiles: 40, maxFileBytes: 3 });

  assert.deepEqual(result.inventoryLines, ["long.txt (6 bytes, truncated)"]);
  assert.match(result.promptBlock, /abc\n\[truncated\]/);
});

test("collectContext supports ** glob matching for nested files", () => {
  const cwd = makeTempTree();
  writeText(cwd, "src/nested/app.js", "console.log('x');\n");
  writeText(cwd, "src/nested/app.css", "body {}\n");

  const result = collectContext({ cwd, files: ["**/*.js"], maxFiles: 40, maxFileBytes: 32768 });

  assert.deepEqual(includedPaths(result), ["src/nested/app.js"]);
});

test("collectContext supports ? single-character glob matching", () => {
  const cwd = makeTempTree();
  writeText(cwd, "a1.txt", "one\n");
  writeText(cwd, "a12.txt", "two\n");

  const result = collectContext({ cwd, files: ["a?.txt"], maxFiles: 40, maxFileBytes: 32768 });

  assert.deepEqual(includedPaths(result), ["a1.txt"]);
});

test("collectContext throws a clear error for missing directories", () => {
  const cwd = makeTempTree();

  assert.throws(
    () => collectContext({ cwd, dirs: ["missing"], maxFiles: 40, maxFileBytes: 32768 }),
    /Context directory does not exist: missing/
  );
});

test("splitCommaList trims whitespace and drops empty entries", () => {
  assert.deepEqual(splitCommaList(""), []);
  assert.deepEqual(splitCommaList("  alpha , beta ,, "), ["alpha", "beta"]);
  assert.deepEqual(splitCommaList("one,"), ["one"]);
});

test("collectContext rejects dirs that escape the workspace via ..", () => {
  const cwd = makeTempTree();
  const sibling = makeTempTree();
  writeText(sibling, "secret.txt", "leak\n");

  const escape = path.relative(cwd, sibling);
  assert.throws(
    () => collectContext({ cwd, dirs: [escape], maxFiles: 40, maxFileBytes: 32768 }),
    /escapes workspace root/
  );
});

test("collectContext rejects absolute dirs outside the workspace", () => {
  const cwd = makeTempTree();
  const sibling = makeTempTree();

  assert.throws(
    () => collectContext({ cwd, dirs: [sibling], maxFiles: 40, maxFileBytes: 32768 }),
    /escapes workspace root/
  );
});

test("collectContext rejects file patterns that resolve outside the workspace", () => {
  const cwd = makeTempTree();
  const sibling = makeTempTree();
  const leakedFile = writeText(sibling, "secret.txt", "leak\n");

  assert.throws(
    () => collectContext({ cwd, files: [leakedFile], maxFiles: 40, maxFileBytes: 32768 }),
    /escapes workspace root/
  );
});

test("collectContext fences each file with backticks longer than any in-file run", () => {
  const cwd = makeTempTree();
  // Three backticks inside a file would close a triple-fence prompt block
  // and let subsequent bytes leak out as plain prompt text.
  writeText(cwd, "tricky.md", "```js\nrun();\n```\n");
  writeText(cwd, "plain.txt", "just text\n");

  const result = collectContext({ cwd, dirs: ["."], maxFiles: 40, maxFileBytes: 32768 });

  // tricky.md opens with exactly 4 backticks (the inner ``` is not enough
  // to close it). The (?!`) lookahead enforces "exactly 4, not 5+".
  assert.match(result.promptBlock, /(?<!`)`{4}(?!`)tricky\.md\n/);
  // ...and closes with a matching 4-backtick fence.
  assert.match(result.promptBlock, /\n(?<!`)`{4}(?!`)/);
  // plain.txt uses the default 3-backtick fence.
  assert.match(result.promptBlock, /(?<!`)`{3}(?!`)plain\.txt\n/);
});

test("collectContext allows escaping paths when allowOutsideWorkspace is set", () => {
  const cwd = makeTempTree();
  const sibling = makeTempTree();
  writeText(sibling, "permitted.txt", "ok\n");

  const result = collectContext({
    cwd,
    dirs: [sibling],
    maxFiles: 40,
    maxFileBytes: 32768,
    allowOutsideWorkspace: true
  });
  assert.equal(result.includedFiles.length, 1, "expected one file when escape is opted in");
  assert.match(result.includedFiles[0].path, /permitted\.txt$/);
});
