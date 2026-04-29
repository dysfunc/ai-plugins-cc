import { fileURLToPath } from "node:url";

export const providerId = "gemini";
export const providerLabel = "Gemini";
export const commandPrefix = "gemini";
export const companionPath = fileURLToPath(new URL("./gemini-companion.mjs", import.meta.url));
