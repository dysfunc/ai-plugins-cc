# @ai-plugins-cc/shared-prompts

Canonical prompt templates and the review-output JSON schema, shared across providers.

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

## Per-provider override

Providers can substitute their own template by passing an override path to the prompt loader. Defaults live here.
