/**
 * Normalize upstream codex-plugin-cc review output to our shared schema.
 *
 * Since gemini and grok were originally forked from codex, the output JSON
 * shape is structurally identical to what our renderer expects: a top-level
 * object with `verdict`, `summary`, `findings[]`, and optional `next_steps[]`.
 * The normalizer's job is to:
 *   1. parse upstream JSON safely (returning a structured error rather than
 *      throwing inside the dispatcher),
 *   2. enforce the canonical shape (top-level keys, finding fields),
 *   3. surface a clear "unsupported upstream version" diagnostic when the
 *      shape diverges so we degrade loudly, not silently.
 */

const REQUIRED_TOP_LEVEL = ["verdict", "summary", "findings"];
const REQUIRED_FINDING_FIELDS = ["severity", "title", "body", "file"];
const ALLOWED_VERDICTS = new Set(["approve", "needs-attention"]);
const ALLOWED_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

export function normalizeReviewOutput(rawStdout, options = {}) {
  const trimmed = String(rawStdout ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Upstream codex returned empty stdout.",
      raw: rawStdout
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(extractJsonObject(trimmed));
  } catch (err) {
    return {
      ok: false,
      error: `Upstream codex output was not valid JSON: ${err.message}`,
      raw: rawStdout
    };
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in parsed)) {
      return {
        ok: false,
        error: `Upstream codex review JSON is missing required top-level key "${key}". This may indicate an unsupported upstream version (${options.upstreamVersion ?? "unknown"}).`,
        raw: rawStdout
      };
    }
  }

  if (!ALLOWED_VERDICTS.has(parsed.verdict)) {
    return {
      ok: false,
      error: `Upstream codex review verdict "${parsed.verdict}" is not one of: ${[...ALLOWED_VERDICTS].join(", ")}.`,
      raw: rawStdout
    };
  }

  if (!Array.isArray(parsed.findings)) {
    return {
      ok: false,
      error: "Upstream codex review JSON `findings` must be an array.",
      raw: rawStdout
    };
  }

  for (const [index, finding] of parsed.findings.entries()) {
    for (const field of REQUIRED_FINDING_FIELDS) {
      if (!(field in finding)) {
        return {
          ok: false,
          error: `Upstream codex review finding[${index}] is missing required field "${field}".`,
          raw: rawStdout
        };
      }
    }
    if (!ALLOWED_SEVERITIES.has(finding.severity)) {
      return {
        ok: false,
        error: `Upstream codex review finding[${index}].severity is "${finding.severity}"; expected one of: ${[...ALLOWED_SEVERITIES].join(", ")}.`,
        raw: rawStdout
      };
    }
  }

  return {
    ok: true,
    review: {
      verdict: parsed.verdict,
      summary: String(parsed.summary ?? ""),
      findings: parsed.findings,
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps : []
    },
    raw: rawStdout
  };
}

// Extract the first top-level JSON object from a stdout blob. Some CLIs
// prepend log lines; this is permissive about leading prose.
function extractJsonObject(text) {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return text;
  return text.slice(firstBrace);
}
