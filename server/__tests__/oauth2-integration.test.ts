/**
 * OAuth2 Integration Tests
 * Tests the full OAuth2 flow with the server
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

describe("OAuth2 Integration", () => {
  // im-a-dev profile is tls:'required'. The authoritative TLS gate (SEC-1) now
  // refuses to start on plaintext, so this integration test serves real HTTPS
  // with a throwaway self-signed cert and talks to it over https, with TLS
  // verification disabled for the self-signed cert.
  const baseUrl = "https://localhost:3001";
  let server: any;
  const savedRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeAll(async () => {
    // Generate a throwaway self-signed cert+key for the required-TLS profile.
    const { generateSelfSignedPem } = await import("./helpers/self-signed");
    const { cert, key } = generateSelfSignedPem();

    // Set up environment for OAuth2
    process.env.SECURITY_PROFILE = "im-a-dev";
    process.env.OAUTH_CLIENT_ID = "integration-test-client";
    process.env.OAUTH_CLIENT_SECRET = "integration-test-secret";
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.PORT = "3001";
    process.env.HOST = "127.0.0.1";
    process.env.TLS_CERT = cert; // real inline PEM — TLS actually enabled
    process.env.TLS_KEY = key;
    process.env.IP_WHITELIST = "disable"; // Disable IP whitelist for testing
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // accept the self-signed cert

    // Import and start server
    const serverModule = await import("../main");
    server = Bun.serve(serverModule.default);

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    if (server) {
      server.stop();
    }
    // Clean up env vars
    delete process.env.SECURITY_PROFILE;
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_CLIENT_SECRET;
    delete process.env.JWT_SECRET;
    delete process.env.TLS_CERT;
    delete process.env.TLS_KEY;
    delete process.env.IP_WHITELIST;
    if (savedRejectUnauthorized === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedRejectUnauthorized;
    }
  });

  test("health endpoint works without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.status).toBe("ok");
    expect(json.profile).toBe("I'm a Dev");
  });

  test("protected endpoint rejects without token", async () => {
    const res = await fetch(`${baseUrl}/vaults`);
    expect(res.status).toBe(401);

    const json = (await res.json()) as any;
    expect(json.error).toBe("unauthorized");
  });

  test("complete OAuth2 flow: credentials -> access token -> API call", async () => {
    // Step 1: Get tokens via client_credentials
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "integration-test-client",
      client_secret: "integration-test-secret",
    });

    const tokenRes = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });

    expect(tokenRes.status).toBe(200);
    const tokenJson = (await tokenRes.json()) as any;
    expect(tokenJson.access_token).toBeDefined();
    expect(tokenJson.refresh_token).toBeDefined();
    expect(tokenJson.token_type).toBe("Bearer");
    expect(tokenJson.expires_in).toBe(900);

    const accessToken = tokenJson.access_token;

    // Step 2: Use access token to call protected endpoint
    const apiRes = await fetch(`${baseUrl}/vaults`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    expect(apiRes.status).toBe(200);
    const apiJson = (await apiRes.json()) as any;
    expect(apiJson.vaults).toBeDefined();
  });

  test("refresh token flow", async () => {
    // Step 1: Get initial tokens
    const tokenBody1 = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "integration-test-client",
      client_secret: "integration-test-secret",
    });

    const tokenRes1 = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody1.toString(),
    });

    const tokenJson1 = (await tokenRes1.json()) as any;
    const refreshToken = tokenJson1.refresh_token;

    // Step 2: Use refresh token to get new tokens
    const tokenBody2 = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const tokenRes2 = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody2.toString(),
    });

    expect(tokenRes2.status).toBe(200);
    const tokenJson2 = (await tokenRes2.json()) as any;
    expect(tokenJson2.access_token).toBeDefined();
    expect(tokenJson2.refresh_token).toBeDefined();

    // Step 3: Verify new access token works
    const apiRes = await fetch(`${baseUrl}/vaults`, {
      headers: {
        Authorization: `Bearer ${tokenJson2.access_token}`,
      },
    });

    expect(apiRes.status).toBe(200);
  });

  test("invalid credentials are rejected", async () => {
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "integration-test-client",
      client_secret: "wrong-secret",
    });

    const tokenRes = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });

    expect(tokenRes.status).toBe(401);
    const json = (await tokenRes.json()) as any;
    expect(json.error).toBe("invalid_client");
  });

  test("invalid token is rejected", async () => {
    const apiRes = await fetch(`${baseUrl}/vaults`, {
      headers: {
        Authorization: "Bearer invalid.jwt.token",
      },
    });

    expect(apiRes.status).toBe(401);
    const json = (await apiRes.json()) as any;
    expect(json.error).toBe("unauthorized");
  });

  test("refresh token cannot be used for API access", async () => {
    // Get tokens
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "integration-test-client",
      client_secret: "integration-test-secret",
    });

    const tokenRes = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });

    const tokenJson = (await tokenRes.json()) as any;
    const refreshToken = tokenJson.refresh_token;

    // Try to use refresh token for API access
    const apiRes = await fetch(`${baseUrl}/vaults`, {
      headers: {
        Authorization: `Bearer ${refreshToken}`,
      },
    });

    expect(apiRes.status).toBe(401);
    const json = (await apiRes.json()) as any;
    expect(json.error).toBe("unauthorized");
    expect(json.error_description).toContain("Invalid token type");
  });
});
