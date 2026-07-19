import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTED_PROVIDER_SECRET,
  redactProviderFailure,
  redactProviderFailureData,
  secretHeaderValues
} from "../global-hooks/provider-error-redaction.mjs";

test("redacts Basic, Bearer, URL userinfo, and exact configured secrets", () => {
  const exact = "fake_exact_provider_secret";
  const basic = ["Basic", "dXNlcjpwYXNz"].join(" ");
  const bearer = ["Bearer", "bearer-fake-token"].join(" ");
  const userInfoUrl = ["https://", ["alice", "password"].join(String.fromCharCode(58)), "@example.invalid/v1"].join("");
  const value = [
    `Authorization: ${basic}`,
    bearer,
    userInfoUrl,
    `detail=${exact}`
  ].join(" | ");
  const redacted = redactProviderFailure(value, { secrets: [exact] });
  assert.doesNotMatch(redacted, /dXNlcjpwYXNz|bearer-fake-token|alice:password|fake_exact_provider_secret/);
  assert.match(redacted, new RegExp(REDACTED_PROVIDER_SECRET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("recursively redacts plain diagnostic objects without mutating the input", () => {
  const originalError = ["Bearer", "token-123"].join(" ");
  const source = { error: originalError, nested: [["https://", ["u", "p"].join(String.fromCharCode(58)), "@example.invalid"].join("")] };
  const safe = redactProviderFailureData(source);
  assert.equal(source.error, originalError);
  assert.doesNotMatch(safe.error, /token-123/);
  assert.doesNotMatch(safe.nested[0], /u:p/);
});

test("redacts bare scalar and collection values under sensitive object keys", () => {
  const source = {
    apiKey: "short",
    apiKeys: ["first", "second"],
    authorization: "bare-secret",
    nested: { refreshToken: 12345, auth: "oauth-secret", token_count: 7 }
  };
  const safe = redactProviderFailureData(source);

  assert.equal(safe.apiKey, REDACTED_PROVIDER_SECRET);
  assert.equal(safe.apiKeys, REDACTED_PROVIDER_SECRET);
  assert.equal(safe.authorization, REDACTED_PROVIDER_SECRET);
  assert.equal(safe.nested.refreshToken, REDACTED_PROVIDER_SECRET);
  assert.equal(safe.nested.auth, REDACTED_PROVIDER_SECRET);
  assert.equal(safe.nested.token_count, 7, "non-credential telemetry is preserved");
  assert.equal(source.apiKey, "short", "the source object is not mutated");
});

test("secretHeaderValues selects credential-like headers only", () => {
  const basic = ["Basic", "abc"].join(" ");
  assert.deepEqual(secretHeaderValues({
    Authorization: basic,
    "X-API-Key": "fake-key",
    "User-Agent": "peerbench-test"
  }), [basic, "fake-key"]);
});
