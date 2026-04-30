#!/usr/bin/env node
// SessionStart hook for the umbrella plugin. If the user has never run
// /ai:setup, print a one-line nudge to stderr. The hook never blocks the
// session and never tries to take over the conversation — it just leaves a
// trail-marker the user (or Claude) can act on.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SETTINGS_FILE = path.join(os.homedir(), ".claude", "ai-plugins-cc.json");

function hasUserConfig() {
  try {
    const stat = fs.statSync(SETTINGS_FILE);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

if (!hasUserConfig()) {
  process.stderr.write(
    "ai-plugins-cc: no settings yet — run /ai:setup to choose providers and connect API keys.\n"
  );
}

// Always exit 0; the hook is informational only.
process.exit(0);
