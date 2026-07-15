/**
 * server/__tests__/field-deny.test.ts
 *
 * Per-client field-level deny (API_DENY_FIELDS_<CLIENT>). The deny map is keyed
 * by the SAME scopeKey normalization FolderScope uses, so a `legacy:<client>`
 * subject correctly matches a rule stored for `<client>`.
 *
 * Falsifiable (F4 anti-fail-open): the LEGACY-subject test below strips a denied
 * field only because filterDeniedFields normalizes its lookup via scopeKey.
 * Reverting that lookup to a raw `clientDeniedFields.get(clientId)` makes the
 * legacy subject miss the rule and the denied field LEAKS — that test fails.
 */

import { expect, describe, test, beforeEach, afterEach } from "bun:test";
import {
  loadDenyFields,
  filterDeniedFields,
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

describe("field-deny normalization (scopeKey)", () => {
  test("scopeKey strips legacy: prefix and lowercases", () => {
    expect(scopeKey("legacy:payroll")).toBe("payroll");
    expect(scopeKey("legacy:legacy:PAYROLL")).toBe("payroll");
    expect(scopeKey("PAYROLL")).toBe("payroll");
  });

  // The anti-fail-open test. A LEGACY subject must have its denied field
  // stripped — proving loadDenyFields stores under scopeKey AND
  // filterDeniedFields looks up under scopeKey.
  test("LEGACY subject: denied field IS stripped (fails open if lookup un-normalized)", () => {
    withDenyEnv("login.password,notes", () => {
      const obj = {
        "login.username": "alice",
        "login.password": "hunter2",
        notes: "top secret",
      };
      const filtered = filterDeniedFields("legacy:payroll", obj);
      expect(filtered["login.password"]).toBeUndefined();
      expect(filtered.notes).toBeUndefined();
      // Non-denied field survives.
      expect(filtered["login.username"]).toBe("alice");
      // Original object is not mutated.
      expect(obj["login.password"]).toBe("hunter2");
    });
  });

  test("non-legacy subject with same key also stripped (parity)", () => {
    withDenyEnv("login.password", () => {
      const filtered = filterDeniedFields("payroll", {
        "login.password": "x",
        keep: "y",
      });
      expect(filtered["login.password"]).toBeUndefined();
      expect(filtered.keep).toBe("y");
    });
  });

  test("no rule for the client → no-op (returns object unchanged)", () => {
    withDenyEnv("login.password", () => {
      const obj = { "login.password": "x", other: "y" };
      // "rico" has no API_DENY_FIELDS_RICO rule.
      const filtered = filterDeniedFields("legacy:rico", obj);
      expect(filtered).toEqual(obj);
      expect(filtered["login.password"]).toBe("x");
    });
  });

  test("no deny env at all → global no-op", () => {
    withDenyEnv(undefined, () => {
      const obj = { "login.password": "x" };
      expect(filterDeniedFields("legacy:payroll", obj)["login.password"]).toBe(
        "x",
      );
    });
  });
});
