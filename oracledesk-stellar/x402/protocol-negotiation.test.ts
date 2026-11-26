/**
 * Tests for protocol-negotiation.ts.
 *
 * # What is covered
 *
 * Success path
 *   - Client and server share the same current version → accepted.
 *   - Client sends an older version that the server still accepts → accepted
 *     with the client's (lower) version.
 *
 * Failure / boundary
 *   - Client sends a version the server no longer supports (too old).
 *   - Client sends a future version the server doesn't know yet (too new).
 *   - Client sends no version (undefined / NaN / 0 / negative).
 *   - Policy with min > max is rejected at construction time.
 *
 * Version-related helpers
 *   - `isCompatible`: v2 client / v2 server, v1 client / v2 server, etc.
 *   - `deprecationHeader`: emits a header only for versions below current.
 *   - `extractVersion`: round-trips through the base64 header format.
 *
 * Old-client behavior during staged transition
 *   - A v1 client hitting a v2-only server receives a versioned error body
 *     containing `minVersion` and `maxVersion` so it can display a useful
 *     "please upgrade" message.
 *   - A v2 client hitting a server configured to also accept v1 receives a
 *     `Deprecation` header telling it the lower version is deprecated.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  negotiate,
  isCompatible,
  deprecationHeader,
  extractVersion,
  assertValidPolicy,
  CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  PROTOCOL_MAX_VERSION,
  type VersionPolicy,
} from "./protocol-negotiation.js";

// ─── negotiate() – success ─────────────────────────────────────────────────────

test("negotiate: same current version → accepted", () => {
  const result = negotiate(CURRENT_VERSION, { minVersion: 2, maxVersion: 2 });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.version, CURRENT_VERSION);
});

test("negotiate: client sends supported older version → accepted at that version", () => {
  const result = negotiate(1, { minVersion: 1, maxVersion: 2 });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.version, 1);
});

test("negotiate: client sends current version against expanded policy → accepted at current", () => {
  const result = negotiate(2, { minVersion: 1, maxVersion: 2 });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.version, 2);
});

// ─── negotiate() – failure / boundary ─────────────────────────────────────────

test("negotiate: client version too old → versioned error with min/maxVersion", () => {
  const result = negotiate(1, { minVersion: 2, maxVersion: 2 });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.error.error, "version_not_supported");
    assert.equal(result.error.minVersion, 2);
    assert.equal(result.error.maxVersion, 2);
    assert.equal(result.httpStatus, 402);
  }
});

test("negotiate: client version too new → versioned error", () => {
  const result = negotiate(99, { minVersion: 2, maxVersion: 2 });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.error.error, "version_not_supported");
    assert.equal(result.httpStatus, 402);
  }
});

test("negotiate: undefined version → version_missing error", () => {
  const result = negotiate(undefined, { minVersion: 2, maxVersion: 2 });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.error, "version_missing");
});

test("negotiate: zero version → version_missing error", () => {
  const result = negotiate(0, { minVersion: 2, maxVersion: 2 });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.error, "version_missing");
});

test("negotiate: negative version → version_missing error", () => {
  const result = negotiate(-1, { minVersion: 2, maxVersion: 2 });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.error, "version_missing");
});

test("negotiate: non-integer version → version_missing error", () => {
  const result = negotiate(1.5 as unknown as number, { minVersion: 2, maxVersion: 2 });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.error, "version_missing");
});

// ─── assertValidPolicy ─────────────────────────────────────────────────────────

test("assertValidPolicy: min > max throws", () => {
  assert.throws(
    () => assertValidPolicy({ minVersion: 3, maxVersion: 1 }),
    /Invalid version policy/,
  );
});

test("assertValidPolicy: version below supported range throws", () => {
  assert.throws(
    () => assertValidPolicy({ minVersion: 0, maxVersion: 2 }),
    /Invalid version policy/,
  );
});

test("assertValidPolicy: version above supported range throws", () => {
  assert.throws(
    () => assertValidPolicy({ minVersion: 1, maxVersion: 999 }),
    /Invalid version policy/,
  );
});

test("assertValidPolicy: valid single-version policy passes", () => {
  assert.doesNotThrow(() => assertValidPolicy({ minVersion: 2, maxVersion: 2 }));
});

test("assertValidPolicy: valid range passes", () => {
  assert.doesNotThrow(() =>
    assertValidPolicy({ minVersion: PROTOCOL_MIN_VERSION, maxVersion: PROTOCOL_MAX_VERSION }),
  );
});

// ─── isCompatible ─────────────────────────────────────────────────────────────

test("isCompatible: same version is always compatible", () => {
  assert.ok(isCompatible(2, 2));
  assert.ok(isCompatible(1, 1));
});

test("isCompatible: v1 client cannot parse v2 server response", () => {
  assert.ok(!isCompatible(1, 2));
});

test("isCompatible: v2 client can parse v2 server response", () => {
  assert.ok(isCompatible(2, 2));
});

// ─── deprecationHeader ────────────────────────────────────────────────────────

test("deprecationHeader: returns undefined for current version", () => {
  assert.equal(deprecationHeader(CURRENT_VERSION), undefined);
});

test("deprecationHeader: returns IMF-fixdate string for older version", () => {
  const header = deprecationHeader(1);
  assert.ok(typeof header === "string");
  // RFC 8594 date: must look like "Ddd, DD Mon YYYY HH:MM:SS GMT"
  assert.match(header!, /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
});

// ─── extractVersion ───────────────────────────────────────────────────────────

test("extractVersion: round-trips a numeric x402Version through the header format", () => {
  const header = Buffer.from(JSON.stringify({ x402Version: 2, foo: "bar" })).toString("base64");
  assert.equal(extractVersion(header), 2);
});

test("extractVersion: returns undefined for non-base64 garbage", () => {
  assert.equal(extractVersion("!!!invalid!!!"), undefined);
});

test("extractVersion: returns undefined when field is missing", () => {
  const header = Buffer.from(JSON.stringify({ other: "field" })).toString("base64");
  assert.equal(extractVersion(header), undefined);
});

test("extractVersion: returns undefined when field is a string instead of number", () => {
  const header = Buffer.from(JSON.stringify({ x402Version: "2" })).toString("base64");
  assert.equal(extractVersion(header), undefined);
});

// ─── Old-client staged-transition behavior ────────────────────────────────────

test("v1 client against v2-only server: error body carries upgrade guidance", () => {
  const policy: VersionPolicy = { minVersion: 2, maxVersion: 2 };
  const result = negotiate(1, policy);
  assert.ok(!result.ok);
  if (!result.ok) {
    // The body must tell the client exactly what versions to use.
    assert.ok(typeof result.error.message === "string");
    assert.ok(result.error.message!.includes("1"));   // mentions client's version
    assert.ok(result.error.message!.includes("2"));   // mentions server's min
    assert.equal(result.error.minVersion, 2);
    assert.equal(result.error.maxVersion, 2);
  }
});

test("v2 client against v1+v2 policy: negotiates to v2 (highest common)", () => {
  const result = negotiate(2, { minVersion: 1, maxVersion: 2 });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.version, 2);
});

test("v1 client against v1+v2 policy: negotiates to v1 (client's capability)", () => {
  const result = negotiate(1, { minVersion: 1, maxVersion: 2 });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.version, 1);
  // A Deprecation header should accompany the response.
  assert.ok(typeof deprecationHeader(1) === "string");
});
