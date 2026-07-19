// Sanitize provider diagnostics before they reach output, traces, or cooldown state.
export const REDACTED_PROVIDER_SECRET = "[redacted]";

const SENSITIVE_KEY = String.raw`(?:authorization|auth|api(?:[_\-\s]?key)|access(?:[_\-\s]?token)|refresh(?:[_\-\s]?token)|token|password|secret)`;
const QUOTED_KEY = String.raw`(?:"${SENSITIVE_KEY}"|'${SENSITIVE_KEY}'|${SENSITIVE_KEY})`;
const SENSITIVE_OBJECT_KEY = /^(?:authorization|auth|api[_\-\s]?keys?|access[_\-\s]?token|refresh[_\-\s]?token|token|password|secret)$/i;
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function redactExactSecret(text, value) {
  const secret = String(value ?? "");
  if (!secret || secret === REDACTED_PROVIDER_SECRET) return text;
  if (secret.length >= 8) return text.split(secret).join(REDACTED_PROVIDER_SECRET);
  return text.replace(
    new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(secret)}(?=$|[^A-Za-z0-9])`, "g"),
    `$1${REDACTED_PROVIDER_SECRET}`
  );
}

export function redactProviderFailure(value, { secrets = [] } = {}) {
  let text = String(value ?? "");
  const exact = [...new Set((Array.isArray(secrets) ? secrets : [secrets])
    .flat()
    .filter((secret) => secret !== undefined && secret !== null && String(secret) !== "")
    .map(String))]
    .sort((a, b) => b.length - a.length);
  for (const secret of exact) text = redactExactSecret(text, secret);

  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/?#\s@]+)@/gi, `$1${REDACTED_PROVIDER_SECRET}@`);
  text = text.replace(
    new RegExp(`(${QUOTED_KEY}\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*"`, "gi"),
    `$1"${REDACTED_PROVIDER_SECRET}"`
  );
  text = text.replace(
    new RegExp(`(${QUOTED_KEY}\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*'`, "gi"),
    `$1'${REDACTED_PROVIDER_SECRET}'`
  );
  text = text.replace(
    /((?:"authorization"|'authorization'|authorization)\s*[:=]\s*)(?:(?:basic|bearer)\s+)?[^\s,}\[\]"';&]+/gi,
    `$1${REDACTED_PROVIDER_SECRET}`
  );
  text = text.replace(
    new RegExp(`(${QUOTED_KEY}\\s*[:=]\\s*)[^\\s,}\\[\\]"';&]+`, "gi"),
    `$1${REDACTED_PROVIDER_SECRET}`
  );
  return text
    .replace(/\b(bearer|basic)(\s+)"(?:\\.|[^"\\\r\n])*"/gi, `$1$2"${REDACTED_PROVIDER_SECRET}"`)
    .replace(/\b(bearer|basic)(\s+)'(?:\\.|[^'\\\r\n])*'/gi, `$1$2'${REDACTED_PROVIDER_SECRET}'`)
    .replace(/\b(bearer|basic)(\s+)[^\s,;)}\[\]"'&]+/gi, `$1$2${REDACTED_PROVIDER_SECRET}`);
}

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
  for (const [key, item] of Object.entries(value)) {
    copy[key] = SENSITIVE_OBJECT_KEY.test(key) && item != null
      ? REDACTED_PROVIDER_SECRET
      : redactProviderFailureData(item, options, seen);
  }
  return copy;
}

export function secretHeaderValues(headers = {}) {
  return Object.entries(headers || {})
    .filter(([name]) => /(?:authorization|api[_\-]?key|access[_\-]?token|refresh[_\-]?token|token|password|secret)/i.test(name))
    .map(([, value]) => value)
    .filter((value) => typeof value === "string" && value);
}
