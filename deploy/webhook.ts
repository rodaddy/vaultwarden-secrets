/**
 * Internal Deploy Trigger
 *
 * Lightweight HTTP endpoint that triggers git pull + service restart.
 * Designed to be called from local network after `git push`.
 *
 * Usage: git deploy  (alias that pushes then curls this endpoint)
 *
 * Environment:
 *   WEBHOOK_PORT    - Listen port (default: 3002)
 *   DEPLOY_SCRIPT   - Path to deploy script (default: ./deploy/deploy.sh)
 *
 * @module deploy/webhook
 */

const PORT = parseInt(process.env.WEBHOOK_PORT || '3002', 10);
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || '/opt/vaultwarden-secrets/deploy/deploy.sh';

let deploying = false;

async function runDeploy(): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(['sh', DEPLOY_SCRIPT], {
    cwd: '/opt/vaultwarden-secrets',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode === 0) {
    return { ok: true, output: stdout.trim() };
  }
  return { ok: false, output: `exit ${exitCode}: ${stderr.trim() || stdout.trim()}` };
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch: async (req) => {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'deploy-trigger', deploying });
    }

    if (url.pathname === '/deploy' && req.method === 'POST') {
      if (deploying) {
        return Response.json({ ok: false, message: 'Deploy already in progress' }, { status: 429 });
      }

      deploying = true;
      console.log(`[deploy] Triggered at ${new Date().toISOString()}`);

      try {
        const result = await runDeploy();
        if (result.ok) {
          console.log(`[deploy] ${result.output}`);
        } else {
          console.error(`[deploy] Failed: ${result.output}`);
        }
        return Response.json(result);
      } finally {
        deploying = false;
      }
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`[deploy] Listening on http://0.0.0.0:${PORT}/deploy`);
