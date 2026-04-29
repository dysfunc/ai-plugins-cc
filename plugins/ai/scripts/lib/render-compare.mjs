import { getProvider } from "./providers.mjs";

/**
 * Render a side-by-side summary of /ai:compare results. Keeps each provider's
 * output as a fenced section with its label; surfaces failures distinctly so
 * a single broken provider doesn't mask the others.
 */
export function renderCompareReport(results) {
  const lines = ["# AI Compare", ""];
  const ok = results.filter((r) => r.status === 0);
  const failed = results.filter((r) => r.status !== 0);
  lines.push(`Providers: ${results.length}  •  ok: ${ok.length}  •  failed: ${failed.length}`);
  lines.push("");

  for (const result of results) {
    const provider = safeProvider(result.providerId);
    lines.push(`## ${provider.label}`);
    if (result.status === 0) {
      lines.push("Status: ok");
      if (result.stdout.trim()) {
        lines.push("");
        const fence = pickFence(result.stdout);
        lines.push(`${fence}stdout`);
        lines.push(result.stdout.trimEnd());
        lines.push(fence);
      }
    } else {
      lines.push(`Status: failed (exit=${result.status}${result.timedOut ? ", timed out" : ""})`);
      const failureBlock = result.stderr.trim() || result.error || "(no stderr)";
      lines.push("");
      const fence = pickFence(failureBlock);
      lines.push(`${fence}stderr`);
      lines.push(failureBlock);
      lines.push(fence);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function safeProvider(id) {
  try {
    return getProvider(id);
  } catch {
    return { id, label: id };
  }
}

function pickFence(content) {
  let longest = 2;
  const runs = String(content).match(/`+/g);
  if (runs) for (const run of runs) if (run.length > longest) longest = run.length;
  return "`".repeat(longest + 1);
}
