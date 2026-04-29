import { fileURLToPath } from "node:url";

export const providerId = "grok";
export const providerLabel = "Grok";
export const commandPrefix = "grok";
export const companionPath = fileURLToPath(new URL("./grok-companion.mjs", import.meta.url));
