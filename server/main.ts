/**
 * Vaultwarden Secrets Server
 * Provides HTTP API for secret retrieval with tiered security profiles
 */

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getProfile, validateProfile } from './profiles';
import { getSecret, listVaults } from '../index';
import { ipWhitelist } from './middleware/ip-whitelist';
import { bearerAuth, loadBearerTokens } from './middleware/bearer-auth';
import { oauth2Auth } from './middleware/oauth2-auth';
import { rateLimit } from './middleware/rate-limit';
import { auditLogger } from './middleware/audit-logger';
import { detectLocalNetwork } from './utils/network-detect';
import { responseEncryption } from './middleware/response-encryption';
import { createAuthRouter, loadOAuthClients } from './routes/auth';

const app = new Hono();

// Load security profile
const SECURITY_PROFILE = process.env.SECURITY_PROFILE || 'im-aware';
const profile = getProfile(SECURITY_PROFILE);

// Validate profile configuration
validateProfile(profile);

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`🔒 Security Profile: ${profile.name}`);
console.log(`   ${profile.description}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// Display warning for insecure profiles
if (profile.warning) {
  console.warn(profile.warning);
  console.log('');
}

// Apply CORS
if (profile.ipWhitelist === false) {
  app.use('*', cors());
} else {
  const allowedOrigins = Array.isArray(profile.ipWhitelist)
    ? profile.ipWhitelist.map(ip => `http://${ip}`)
    : ['http://10.71.20.*'];

  app.use('*', cors({ origin: allowedOrigins }));
}

// Health check endpoint (always public, no auth required)
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    profile: profile.name,
    timestamp: new Date().toISOString(),
  });
});

// Apply middleware based on profile
console.log('Active security layers:');

// 1. IP Whitelist (with auto-detection)
if (profile.ipWhitelist) {
  let ranges: string[] = [];

  // Auto-detect local network
  if (profile.ipWhitelist === 'auto') {
    const detected = await detectLocalNetwork();
    if (detected) {
      ranges = [detected];
      console.log(`  ℹ Auto-detected network: ${detected}`);
    } else {
      console.warn('  ⚠  Could not auto-detect network, using RFC1918 private networks');
      ranges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
    }
  } else if (Array.isArray(profile.ipWhitelist)) {
    ranges = profile.ipWhitelist;
  }

  // Environment override
  if (process.env.IP_WHITELIST) {
    if (process.env.IP_WHITELIST === 'disable') {
      if (profile.name === 'OpenClaw / Clawdbot') {
        console.error('❌ Cannot disable IP whitelist for openclaw profile');
        process.exit(1);
      }
      console.warn('  ⚠  IP Whitelist: DISABLED (via IP_WHITELIST=disable)');
    } else {
      const envRanges = process.env.IP_WHITELIST.split(',');
      // For openclaw, add to base (127.0.0.1/32)
      if (profile.name === 'OpenClaw / Clawdbot') {
        ranges = [...ranges, ...envRanges];
      } else {
        ranges = envRanges;
      }
      console.log(`  ℹ IP_WHITELIST override: ${envRanges.join(', ')}`);
    }
  }

  if (ranges.length > 0) {
    app.use('*', ipWhitelist(ranges));
    console.log(`  ✓ IP Whitelist: ${ranges.join(', ')}`);
  }
}

// 2. Rate Limiting
if (profile.rateLimit) {
  app.use('*', rateLimit(profile.rateLimit));
  console.log(`  ✓ Rate Limiting: ${profile.rateLimit.requests}/${profile.rateLimit.window}`);
}

// 3. Authentication
if (profile.auth === 'bearer') {
  const tokens = loadBearerTokens();
  if (tokens.size === 0) {
    console.error('❌ No API tokens configured!');
    console.error('   Set tokens via: export API_TOKEN_<CLIENT>=<token>');
    process.exit(1);
  }
  app.use('*', bearerAuth({ tokens }));
  console.log(`  ✓ Bearer Auth: ${tokens.size} client(s) configured`);
} else if (profile.auth === 'oauth2') {
  const clients = loadOAuthClients();
  if (clients.size === 0) {
    console.error('❌ No OAuth2 clients configured!');
    console.error('   Set via: export OAUTH_CLIENT_ID=<id> OAUTH_CLIENT_SECRET=<secret>');
    console.error('   Or set: export OAUTH_CLIENTS_FILE=/path/to/clients.json');
    process.exit(1);
  }

  // Mount auth routes
  const authRouter = createAuthRouter(clients);
  app.route('/auth', authRouter);

  // Apply OAuth2 middleware
  app.use('*', oauth2Auth());
  console.log(`  ✓ OAuth2 Auth: ${clients.size} client(s) configured`);
} else if (profile.auth === 'mtls+jwt') {
  // Apply combined mTLS + JWT middleware
  const { createCombinedAuth } = await import('./middleware/combined-auth');
  const combinedAuthMiddleware = await createCombinedAuth();
  app.use('*', combinedAuthMiddleware);
  console.log('  ✓ Combined Auth: mTLS + JWT (defense in depth)');
} else if (profile.auth === false) {
  console.warn('  ⚠  No authentication');
}

// 4. Audit Logging
const auditLogFile = process.env.AUDIT_LOG_FILE;
app.use('*', auditLogger(profile.audit, auditLogFile));
console.log(`  ✓ Audit Logging: ${profile.audit}${auditLogFile ? ` → ${auditLogFile}` : ' (console only)'}`);

// 5. Response Encryption
if (profile.secretsEncrypted) {
  app.use('*', responseEncryption(profile));
  console.log('  ✓ Response Encryption: ECDH P-256 + AES-256-GCM');
}

console.log('');

// List vaults
app.get('/vaults', async (c: Context) => {
  try {
    const vaults = await listVaults();
    return c.json({ vaults });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to list vaults' },
      500
    );
  }
});

// Get secret by name
app.get('/secret/:name', async (c: Context) => {
  const name = decodeURIComponent(c.req.param('name'));
  const vault = c.req.query('vault') || 'default';

  try {
    const value = await getSecret(name, { vault });
    return c.json({ value });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Secret not found' },
      404
    );
  }
});

// Return 405 for unsupported methods on valid paths
const methodNotAllowed = (c: Context) => {
  return c.json(
    { error: 'Method not allowed', allowed: ['GET'] },
    405
  );
};

app.post('/health', methodNotAllowed);
app.put('/health', methodNotAllowed);
app.delete('/health', methodNotAllowed);
app.patch('/health', methodNotAllowed);

app.post('/vaults', methodNotAllowed);
app.put('/vaults', methodNotAllowed);
app.delete('/vaults', methodNotAllowed);
app.patch('/vaults', methodNotAllowed);

app.post('/secret/:name', methodNotAllowed);
app.put('/secret/:name', methodNotAllowed);
app.delete('/secret/:name', methodNotAllowed);
app.patch('/secret/:name', methodNotAllowed);

// Start server
const port = parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '0.0.0.0';

console.log(`Starting server on ${host}:${port}...`);
console.log('');

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};
