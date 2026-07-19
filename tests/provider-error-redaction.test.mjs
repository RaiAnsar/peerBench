import { test } from "node:test";
import assert from "node:assert/strict";
import { redactProviderFailure, redactProviderFailureData } from "../global-hooks/provider-error-redaction.mjs";

const fixtureSecret = (...parts) => parts.join("-");

test("provider failure redaction covers exact configured values and common credential shapes", () => {
  const exact = fixtureSecret("configured", "fixture", "opaque", "value");
  const bearer = fixtureSecret("bearer", "fixture", "credential");
  const basicSource = fixtureSecret("basic", "fixture", "credential");
  const basic = Buffer.from(`fixture:${basicSource}`).toString("base64");
  const apiUnderscore = fixtureSecret("api", "underscore", "fixture");
  const apiCamel = fixtureSecret("api", "camel", "fixture");
  const access = fixtureSecret("access", "fixture", "credential");
  const refresh = fixtureSecret("refresh", "fixture", "credential");
  const token = fixtureSecret("token", "fixture", "credential");
  const urlUser = fixtureSecret("url", "fixture", "user");
  const urlPassword = fixtureSecret("url", "fixture", "password");
  const reflectedUrl = new URL("https://provider.invalid/failure");
  reflectedUrl.username = urlUser;
  reflectedUrl.password = urlPassword;

  const detail = [
    `HTTP 401 reflected opaque credential ${exact}`,
    `Authorization: Bearer ${bearer}`,
    `proxy challenge Basic ${basic}`,
    reflectedUrl.href,
    `api_key=${apiUnderscore}`,
    `apiKey: '${apiCamel}'`,
    JSON.stringify({ access_token: access, refresh_token: refresh }),
    `token="${token}"`
  ].join("; ");

  const redacted = redactProviderFailure(detail, { secrets: [exact] });
  for (const secret of [exact, bearer, basic, apiUnderscore, apiCamel, access, refresh, token, urlUser, urlPassword]) {
    assert.equal(redacted.includes(secret), false, `must remove ${secret.split("-", 1)[0]} credential`);
  }
  assert.match(redacted, /HTTP 401/, "non-secret diagnostic context survives");
  assert.match(redacted, /\[redacted\]/, "redaction stays explicit to the operator");
  assert.equal(redactProviderFailure(redacted, { secrets: [exact] }), redacted, "redaction must be idempotent across cache reads");
});

test("nested failure diagnostics are redacted before a caller can persist them", () => {
  const exact = fixtureSecret("nested", "configured", "fixture");
  const shaped = fixtureSecret("nested", "token", "fixture");
  const result = redactProviderFailureData({
    error: `quota for ${exact}`,
    diag: { rounds: [{ error: `access_token=${shaped}` }] }
  }, { secrets: [exact] });
  assert.equal(JSON.stringify(result).includes(exact), false);
  assert.equal(JSON.stringify(result).includes(shaped), false);
  assert.match(result.error, /quota/);
});
