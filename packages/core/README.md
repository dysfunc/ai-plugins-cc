# @ai-plugins-cc/core

Shared core library for ai-plugins-cc. Every provider plugin and the umbrella import from here.

## Modules

| Subpath | What it owns |
|---|---|
| `@ai-plugins-cc/core/state` | Per-workspace state file with **atomic writes** (temp file + rename) and a **lockfile-based mutex** (`Atomics.wait` backoff, stale-lock recovery) so concurrent foreground+background writers can't tear state. |
| `@ai-plugins-cc/core/process` | `runCommand`, `binaryAvailable`, `terminateProcessTree` (POSIX pgrp + Windows taskkill). |
| `@ai-plugins-cc/core/git` | `collectReviewContext`, `resolveReviewTarget`, etc. |
| `@ai-plugins-cc/core/context` | Workspace-contained file collection. **Rejects paths that escape the workspace root** unless `allowOutsideWorkspace: true`. **Picks a backtick fence longer than any in-content run** so file content with ` ``` ` can't break the prompt structure. |
| `@ai-plugins-cc/core/render` | Markdown rendering of jobs, reviews, status reports. Reads `getProviderId()` and `getProviderLabel()` from `core/config` so each plugin's UI shows its own brand. |
| `@ai-plugins-cc/core/job-control` | Snapshot building, status, cancel resolution. Uses `getCommandPrefix()` from `core/config` for slash-command hints in error messages. |
| `@ai-plugins-cc/core/tracked-jobs` | Background job lifecycle. `SESSION_ID_ENV = "AI_PLUGINS_CC_SESSION_ID"` (legacy `GEMINI_COMPANION_SESSION_ID` still readable). |
| `@ai-plugins-cc/core/workspace` | `resolveWorkspaceRoot`. |
| `@ai-plugins-cc/core/fs` | `readJsonFile`, `createTempDir`, etc. |
| `@ai-plugins-cc/core/args` | Lightweight CLI arg parser. |
| `@ai-plugins-cc/core/prompts` | `loadPromptTemplate`, `interpolateTemplate`. |
| `@ai-plugins-cc/core/config` | Process-scoped provider identity. Plugins call `setProviderIdentity({ commandPrefix, providerId, providerLabel })` at startup. |

## Provider identity

Core has no hardcoded provider name. Each plugin's entry script calls `setProviderIdentity(...)` once before importing anything that emits user-facing strings:

```js
import { setProviderIdentity } from "@ai-plugins-cc/core/config";

setProviderIdentity({
  commandPrefix: "gemini",
  providerId: "gemini",
  providerLabel: "Gemini"
});
```

After that call, every error message, status table, and rendered report uses the configured prefix and label.

## Tests

```sh
npm test --workspace=@ai-plugins-cc/core
```

35 tests covering: context collection (path containment, fence escaping, glob matching), git review context, process termination, render output shapes, state (atomic writes, concurrent writers, prune-on-overflow).
