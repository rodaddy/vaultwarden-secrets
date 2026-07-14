import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "..");
const RETIRED_ARTIFACTS = [
  "deploy/webhook.ts",
  "deploy/systemd/vw-deploy-webhook.service",
] as const;
const EXCLUDED_FILES = new Set(["deploy/retired-trigger.test.ts"]);
const WIRING_PATHS = [
  "deploy",
  ".github/workflows",
  "install.sh",
  "package.json",
  "server-ctl.sh",
] as const;
const RETIRED_ACTIVATION_REFERENCES = [
  /deploy\/webhook\.ts/,
  /vw-deploy-webhook\.service/,
  /WEBHOOK_PORT/,
  /DEPLOY_SCRIPT/,
] as const;

function repositoryFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return repositoryFiles(path);
    }

    return entry.isFile() ? [path] : [];
  });
}

describe("retired network deploy trigger", () => {
  test("source and systemd unit stay absent", () => {
    for (const artifact of RETIRED_ARTIFACTS) {
      expect(existsSync(join(REPOSITORY_ROOT, artifact))).toBe(false);
    }
  });

  test("production and install wiring cannot reactivate the trigger", () => {
    const reactivationReferences: string[] = [];

    const wiringFiles = WIRING_PATHS.flatMap((wiringPath) => {
      const path = join(REPOSITORY_ROOT, wiringPath);
      if (!existsSync(path)) {
        return [];
      }

      return statSync(path).isDirectory() ? repositoryFiles(path) : [path];
    });

    for (const path of wiringFiles) {
      const repositoryPath = relative(REPOSITORY_ROOT, path);
      if (EXCLUDED_FILES.has(repositoryPath)) {
        continue;
      }

      const content = readFileSync(path, "utf8");
      if (
        RETIRED_ACTIVATION_REFERENCES.some((pattern) => pattern.test(content))
      ) {
        reactivationReferences.push(repositoryPath);
      }
    }

    expect(reactivationReferences).toEqual([]);
  });
});
