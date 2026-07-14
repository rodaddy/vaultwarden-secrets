import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "..");
const RETIRED_ARTIFACTS = [
  "deploy/webhook.ts",
  "deploy/systemd/vw-deploy-webhook.service",
] as const;
const WIRING_PATHS = [
  "deploy",
  ".github/workflows",
  "install.sh",
  "package.json",
  "server-ctl.sh",
] as const;
const RETIRED_LEGACY_REFERENCES = [
  /deploy\/webhook\.ts/,
  /WEBHOOK_PORT/,
  /DEPLOY_SCRIPT/,
] as const;
const RETIRED_PORT = /\b3002\b/;
const RETIRED_UNIT = "vw-deploy-webhook.service";
const RETIREMENT_SCRIPT = "deploy/deploy.sh";

function isActivationFile(repositoryPath: string): boolean {
  if (repositoryPath.endsWith(".test.ts")) {
    return false;
  }

  return (
    repositoryPath === "package.json" ||
    /\.(?:sh|service|timer|ts|ya?ml)$/.test(repositoryPath)
  );
}

function repositoryFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Activation path must not be a symlink: ${relative(REPOSITORY_ROOT, path)}`,
      );
    }

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
      if (!isActivationFile(repositoryPath)) {
        continue;
      }

      const content = readFileSync(path, "utf8");
      if (
        RETIRED_LEGACY_REFERENCES.some((pattern) => pattern.test(content)) ||
        RETIRED_PORT.test(content) ||
        (repositoryPath !== RETIREMENT_SCRIPT && content.includes(RETIRED_UNIT))
      ) {
        reactivationReferences.push(repositoryPath);
      }
    }

    expect(reactivationReferences).toEqual([]);
  });

  test("the upgrade path removes the already-installed unit", () => {
    const deployScript = readFileSync(
      join(REPOSITORY_ROOT, RETIREMENT_SCRIPT),
      "utf8",
    );

    expect(deployScript).toContain(`RETIRED_UNIT="${RETIRED_UNIT}"`);
    expect(deployScript).toContain('systemctl disable --now "$RETIRED_UNIT"');
    expect(deployScript).toContain('rm -f "$RETIRED_UNIT_PATH"');
    const disableIndex = deployScript.indexOf("systemctl disable --now");
    const removeIndex = deployScript.indexOf('rm -f "$RETIRED_UNIT_PATH"');
    const reloadIndex = deployScript.indexOf("systemctl daemon-reload");
    const noChangeExitIndex = deployScript.indexOf(
      'if [ "$LOCAL" = "$REMOTE" ]',
    );
    expect(disableIndex).toBeLessThan(removeIndex);
    expect(removeIndex).toBeLessThan(reloadIndex);
    expect(reloadIndex).toBeLessThan(noChangeExitIndex);
    expect(deployScript).not.toMatch(
      /systemctl\s+(?:enable|restart|start)\s+"?\$RETIRED_UNIT"?/,
    );
  });
});
