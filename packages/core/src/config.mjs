// Process-scoped configuration for ai-plugins-cc core. Each Node invocation
// is a separate process; plugins set their identity here once at startup so
// user-facing strings emitted by render/job-control point at the right
// provider, slash command, and brand label.

let commandPrefix = "ai";
let providerId = "ai";
let providerLabel = "AI";

export function setCommandPrefix(prefix) {
  if (typeof prefix !== "string" || !prefix) return;
  commandPrefix = prefix;
}

export function getCommandPrefix() {
  return commandPrefix;
}

export function setProviderId(id) {
  if (typeof id !== "string" || !id) return;
  providerId = id;
}

export function getProviderId() {
  return providerId;
}

export function setProviderLabel(label) {
  if (typeof label !== "string" || !label) return;
  providerLabel = label;
}

export function getProviderLabel() {
  return providerLabel;
}

// Convenience: set all three identity values at once.
export function setProviderIdentity({ commandPrefix, providerId, providerLabel } = {}) {
  setCommandPrefix(commandPrefix);
  setProviderId(providerId);
  setProviderLabel(providerLabel);
}
