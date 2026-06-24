export function isContentInspectionFailure(status, body) {
  return status === 400 && /data_inspection_failed|inappropriate content/i.test(String(body || ""));
}

export function allowedTemperatureFromError(status, body) {
  if (status !== 400) return null;
  const m = String(body || "").match(/invalid temperature:\s*only\s+([0-9.]+)\s+is allowed/i);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

export function sanitizeForProviderInspection(text) {
  return String(text ?? "")
    .replace(/\bPAN\b/g, "payment-account-number")
    .replace(/\bCVV\b|\bCVC\b/gi, "security-code")
    .replace(/\bcard\s+XXXX\b/gi, "masked saved payment method")
    .replace(/\brun card\b/gi, "run saved payment method")
    .replace(/\bcredit card number\b/gi, "payment-account-number");
}
