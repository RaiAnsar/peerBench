// Provider failures may reflect request credentials. One sanitizer protects return, display, and
// cache paths consistently.
export const REDACTED_PROVIDER_SECRET = "[redacted]";

const SENSITIVE_KEY = String.raw`(?:authorization|api(?:[_\-\s]?key)|access(?:[_\-\s]?token)|refresh(?:[_\-\s]?token)|token)`;
const quotedKey = String.raw`(?:"${SENSITIVE_KEY}"|'${SENSITIVE_KEY}'|${SENSITIVE_KEY})`;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function redactExactSecret(text, value) {
  const secret = String(value ?? "");
  if (!secret || secret === REDACTED_PROVIDER_SECRET) return text;
  // Short dev keys require boundaries so ordinary words remain readable.
  if (secret.length >= 8) return text.split(secret).join(REDACTED_PROVIDER_SECRET);
  const bounded = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(secret)}(?=$|[^A-Za-z0-9])`, "g");
  return text.replace(bounded, `$1${REDACTED_PROVIDER_SECRET}`);
}

/**
 * Redact configured credentials plus common reflected-secret shapes from provider failure text.
 * Call this before truncation: otherwise a clipped configured secret no longer matches exactly.
 */
export function redactProviderFailure(value, { secrets = [] } = {}) {
  let text = String(value ?? "");
  const exact = [...new Set((Array.isArray(secrets) ? secrets : [secrets])
    .flatMap((secret) => Array.isArray(secret) ? secret : [secret])
    .filter((secret) => secret !== undefined && secret !== null && String(secret) !== "")
    .map(String))]
    .sort((a, b) => b.length - a.length);
  for (const secret of exact) text = redactExactSecret(text, secret);

  // URL credentials can contain punctuation that token-shaped regexes intentionally do not match.
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/?#\s@]+)@/gi, `$1${REDACTED_PROVIDER_SECRET}@`);

  // Handle quoted values first so a Bearer/Basic credential is consumed with its scheme.
  text = text.replace(
    new RegExp(`(${quotedKey}\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*"`, "gi"),
    `$1"${REDACTED_PROVIDER_SECRET}"`
  );
  text = text.replace(
    new RegExp(`(${quotedKey}\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*'`, "gi"),
    `$1'${REDACTED_PROVIDER_SECRET}'`
  );

  // Authorization is special: consume both the optional scheme and its credential.
  text = text.replace(
    /((?:"authorization"|'authorization'|authorization)\s*[:=]\s*)(?:(?:basic|bearer)\s+)?[^\s,}\[\]"';&]+/gi,
    `$1${REDACTED_PROVIDER_SECRET}`
  );
  text = text.replace(
    new RegExp(`(${quotedKey}\\s*[:=]\\s*)[^\\s,}\\[\\]"';&]+`, "gi"),
    `$1${REDACTED_PROVIDER_SECRET}`
  );

  // Also catch free-standing HTTP auth schemes without an Authorization field label.
  text = text
    .replace(/\b(bearer|basic)(\s+)"(?:\\.|[^"\\\r\n])*"/gi, `$1$2"${REDACTED_PROVIDER_SECRET}"`)
    .replace(/\b(bearer|basic)(\s+)'(?:\\.|[^'\\\r\n])*'/gi, `$1$2'${REDACTED_PROVIDER_SECRET}'`)
    .replace(/\b(bearer|basic)(\s+)[^\s,;)}\[\]"'&]+/gi, `$1$2${REDACTED_PROVIDER_SECRET}`);

  return text;
}

// Scrub nested diagnostics while leaving non-plain runtime objects untouched.
export function redactProviderFailureData(value, options = {}, seen = new WeakMap()) {
  if (typeof value === "string") return redactProviderFailure(value, options);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactProviderFailureData(item, options, seen));
    return copy;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = redactProviderFailureData(item, options, seen);
  return copy;
}

export function secretHeaderValues(headers = {}) {
  return Object.entries(headers || {})
    .filter(([name]) => /(?:authorization|api[_\-]?key|access[_\-]?token|refresh[_\-]?token|token|secret)/i.test(name))
    .map(([, value]) => value)
    .filter((value) => typeof value === "string" && value);
}
