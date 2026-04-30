# @ai-plugins-cc/codex-adapter

Adapter that integrates with upstream [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) without vendoring its source.

## Why

Codex isn't ours to maintain — it's an OpenAI plugin. But we want `/ai:review --provider=codex` to work alongside our in-house Gemini and Grok providers, with the same uniform shape. This package is the seam.

## Surface

```js
import {
  discoverCodexInstall,
  installCodexUpstream,
  invokeCodexCommand,
  normalizeReviewOutput,
  readUpstreamConfig
} from "@ai-plugins-cc/codex-adapter";
```

| Module | What it does |
|---|---|
| `discover.mjs` | Locate an installed copy of upstream codex. Source priority: explicit `options.path` / `CODEX_PLUGIN_PATH` env → managed cache (`~/.cache/ai-plugins-cc/codex-plugin-cc/`) → sibling repo (`<cwd>/../codex-plugin-cc`, useful in monorepo dev). Throws a self-explanatory error listing every path tried when nothing is found. |
| `install.mjs` | Fetch a SHA-pinned GitHub release tarball, hash-verify, extract, atomic-rename into the managed cache. `fetchImpl` and `extractImpl` are injectable for tests; defaults use Node's built-in `fetch` and a shell `tar -xzf`. Refuses to install on SHA mismatch and leaves the prior install untouched. |
| `invoke.mjs` | Spawn the upstream `codex-companion.mjs` as a subprocess with security boundaries: env allowlist (`PATH`, `HOME`, locale, `OPENAI_API_KEY`, `CODEX_API_KEY`, …), configurable timeout (default 10 min, kills via SIGKILL on overrun), configurable stdout cap (default 50 MB), resolves on stdio `'close'` so trailing bytes aren't truncated. |
| `normalize.mjs` | Validate upstream review JSON against our canonical schema (`verdict`, `summary`, `findings[]`, optional `next_steps[]`). Surfaces drift as `unsupported upstream version (X.Y.Z)` rather than a generic shape error. Tolerant of leading prose. |

## Pinning

The upstream tag and optional SHA-256 live in this package's `package.json`:

```jsonc
{
  "ai-plugins-cc": {
    "upstream": {
      "repo": "openai/codex-plugin-cc",
      "pinnedTag": "v1.0.4",
      "pinnedSha": null   // SHA-256 of the GitHub source tarball, hex
    }
  }
}
```

`pinnedSha: null` is acceptable for development; production should pin. The daily `codex-canary` workflow re-fetches the pinned tag and would surface a hash mismatch loudly.

## Tests

```sh
npm test --workspace=@ai-plugins-cc/codex-adapter
```

24 tests:

- **discover (5)** — env override, options.path override, sibling-repo discovery, missing-companion rejection, helpful error on miss.
- **install (5)** — happy path, replace-on-rerun, SHA happy path, SHA mismatch refuses install + leaves target untouched, missing-tag error.
- **invoke (5)** — captures stdout, surfaces non-zero exits, enforces timeout, caps stdout, applies env allowlist.
- **normalize (9)** — well-formed pass-through, leading-prose tolerance, defaulted next_steps, empty stdout, malformed JSON, unknown verdict (with version diagnostic), missing top-level key, missing finding field, unknown severity.
