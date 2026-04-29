# Changesets

Independent per-package versioning for `ai-plugins-cc`.

## Workflow

1. Make your code change.
2. Run `npm run changeset` and follow the prompts.
3. Commit the generated `.changeset/<name>.md` alongside your code.
4. CI enforces: any PR touching `packages/core/**` MUST include a changeset entry that mentions `@ai-plugins-cc/core`.

## On release

A maintainer runs `npm run changeset:version` (consuming the markdown changesets, bumping each affected package's version, and updating its CHANGELOG.md), then `npm run changeset:publish`.

Provider plugins depend on `@ai-plugins-cc/core` via `workspace:^`. A patch bump to core ripples to all dependents on the next release as a patch bump.
