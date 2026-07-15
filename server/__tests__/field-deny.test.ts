/**
 * server/__tests__/field-deny.test.ts
 *
 * Per-client field-level deny (API_DENY_FIELDS_<CLIENT>). Enforced on the REAL
 * FLAT key shape produced by index.ts buildFieldsObject — `username`,
 * `password`, `uri`, `totp`, `notes`, and custom-field names — matched
 * case-insensitively after canonicalizing path-style refs. The deny map is
 * keyed by the SAME scopeKey normalization FolderScope uses, so a
 * `legacy:<client>` subject matches a rule stored for `<client>`.
 *
 * Falsifiable (F4 anti-fail-open): the LEGACY-subject test strips a denied
 * field only because filterDeniedFields normalizes its lookup via scopeKey.
 * Reverting to a raw lookup makes the legacy subject miss the rule → field
 * LEAKS → that test fails. The real-shape test fails if enforcement were keyed
 * on a `login.password` alias that never appears in real data.
 */

import { expect, describe, test } from "bun:test";
import {
  loadDenyFields,
  filterDeniedFields,
  isFieldDenied,
  canonicalizeFieldName,
  scopeKey,
} from "../utils/folder-scope";

const DENY_ENV = "API_DENY_FIELDS_PAYROLL";

function withDenyEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env[DENY_ENV];
  if (value === undefined) delete process.env[DENY_ENV];
  else process.env[DENY_ENV] = value;
  try {
    loadDenyFields();
    fn();
  } finally {
    if (prev === undefined) delete process.env[DENY_ENV];
    else process.env[DENY_ENV] = prev;
    loadDenyFields();
  }
}

/** Exactly the object shape index.ts buildFieldsObject emits for a login item. */
function buildFieldsObjectShape(): Record<string, string> {
  return {
    username: "svc-account",
    password: "test-pw-abc",
    uri: "https://example.internal",
    totp: "otpauth://x",
    notes: "line1\nline2",
    API_KEY: "test-key-xyz", // custom field, verbatim name
  };
}

describe("scopeKey normalization", () => {
  test("strips legacy: prefix and lowercases", () => {
    expect(scopeKey("legacy:payroll")).toBe("payroll");
    expect(scopeKey("legacy:legacy:PAYROLL")).toBe("payroll");
    expect(scopeKey("PAYROLL")).toBe("payroll");
  });

  // F4 P2: mixed-case prefix. Opaque workload-token subjects can be any case;
  // lowercasing must happen BEFORE stripping or the prefix survives and the
  // deny/scope lookup fails open.
  test("mixed-case Legacy: prefix normalizes (lowercase-first)", () => {
    expect(scopeKey("Legacy:PAYROLL")).toBe("payroll");
    expect(scopeKey("LEGACY:Payroll")).toBe("payroll");
    expect(scopeKey("Legacy:Legacy:PayRoll")).toBe("payroll");
  });
});

describe("canonicalizeFieldName (path-style → real flat key)", () => {
  test("login.* maps to the flat login-derived key", () => {
    expect(canonicalizeFieldName("login.password")).toBe("password");
    expect(canonicalizeFieldName("login.username")).toBe("username");
    expect(canonicalizeFieldName("login.totp")).toBe("totp");
    expect(canonicalizeFieldName("login.uri")).toBe("uri");
  });
  test("item-prefixed paths and bare suffixes normalize", () => {
    expect(canonicalizeFieldName("item.login.password")).toBe("password");
    expect(canonicalizeFieldName("item.password")).toBe("password");
    expect(canonicalizeFieldName("notes")).toBe("notes");
  });
  test("fields.CUSTOM maps to the custom field name", () => {
    expect(canonicalizeFieldName("item.fields.API_KEY")).toBe("api_key");
    expect(canonicalizeFieldName("fields.token")).toBe("token");
  });
  test("plain flat key passes through (lowercased)", () => {
    expect(canonicalizeFieldName("Password")).toBe("password");
    expect(canonicalizeFieldName("custom_thing")).toBe("custom_thing");
  });
});

describe("filterDeniedFields on the REAL buildFieldsObject shape", () => {
  test("denying `password` strips the real flat `password` key", () => {
    withDenyEnv("password", () => {
      const obj = buildFieldsObjectShape();
      const filtered = filterDeniedFields("payroll", obj);
      expect(filtered.password).toBeUndefined();
      // Everything else survives.
      expect(filtered.username).toBe("svc-account");
      expect(filtered.uri).toBe("https://example.internal");
      expect(filtered.API_KEY).toBe("test-key-xyz");
      // Original not mutated.
      expect(obj.password).toBe("test-pw-abc");
    });
  });

  test("operator writing `login.password` still enforces on real `password`", () => {
    withDenyEnv("login.password", () => {
      const filtered = filterDeniedFields("payroll", buildFieldsObjectShape());
      expect(filtered.password).toBeUndefined();
      expect(filtered.username).toBe("svc-account");
    });
  });

  test("denying a custom field strips it by verbatim name (case-insensitive)", () => {
    withDenyEnv("api_key", () => {
      const filtered = filterDeniedFields("payroll", buildFieldsObjectShape());
      expect(filtered.API_KEY).toBeUndefined();
      expect(filtered.password).toBe("test-pw-abc");
    });
  });
});

describe("field-deny legacy-subject enforcement (anti-fail-open)", () => {
  // Strips a denied field for a LEGACY subject — proves loadDenyFields stores
  // under scopeKey AND filterDeniedFields looks up under scopeKey.
  test("LEGACY subject: denied real field IS stripped", () => {
    withDenyEnv("password,notes", () => {
      const obj = buildFieldsObjectShape();
      const filtered = filterDeniedFields("legacy:payroll", obj);
      expect(filtered.password).toBeUndefined();
      expect(filtered.notes).toBeUndefined();
      expect(filtered.username).toBe("svc-account");
    });
  });

  test("mixed-case legacy subject: denied field IS stripped", () => {
    withDenyEnv("password", () => {
      const filtered = filterDeniedFields(
        "Legacy:PAYROLL",
        buildFieldsObjectShape(),
      );
      expect(filtered.password).toBeUndefined();
    });
  });
});

describe("isFieldDenied predicate", () => {
  test("canonicalizes the reference before deciding", () => {
    withDenyEnv("password", () => {
      expect(isFieldDenied("legacy:payroll", "password")).toBe(true);
      expect(isFieldDenied("legacy:payroll", "login.password")).toBe(true);
      expect(isFieldDenied("legacy:payroll", "item.password")).toBe(true);
      expect(isFieldDenied("legacy:payroll", "username")).toBe(false);
    });
  });
});

describe("no-rule cases → no-op", () => {
  test("client without a rule is untouched", () => {
    withDenyEnv("password", () => {
      const obj = buildFieldsObjectShape();
      // "rico" has no API_DENY_FIELDS_RICO rule.
      expect(filterDeniedFields("legacy:rico", obj)).toEqual(obj);
      expect(isFieldDenied("legacy:rico", "password")).toBe(false);
    });
  });

  test("no deny env at all → global no-op", () => {
    withDenyEnv(undefined, () => {
      const obj = buildFieldsObjectShape();
      expect(filterDeniedFields("legacy:payroll", obj).password).toBe(
        "test-pw-abc",
      );
      expect(isFieldDenied("legacy:payroll", "password")).toBe(false);
    });
  });
});
