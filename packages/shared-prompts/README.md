# @ai-plugins-cc/shared-prompts

Canonical prompt templates and the review-output JSON schema shared across providers.

## Layout

```
prompts/
  review.md
  rescue.md
  gater.md
  adversarial-review.md
schemas/
  review-output.schema.json
```

## API

```js
import { loadPrompt, loadSchema } from "@ai-plugins-cc/shared-prompts";

const reviewTemplate = loadPrompt("review");          // → string (markdown)
const schema = loadSchema("review-output");           // → parsed JSON object
```

## Per-provider override

Providers can substitute their own template by passing an override path to the prompt loader. The defaults here are the source of truth — each plugin's `plugins/<provider>/prompts/` directory exists for backward compatibility and provider-specific tuning, but should converge on these canonical versions over time.

## Status

Skeleton. Phase 1a kept each plugin's prompts in-tree so the move was behavior-preserving. A follow-up will migrate the canonical templates here and have each plugin reference them via `loadPrompt`.
