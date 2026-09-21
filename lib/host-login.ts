// Signing in another Claude account from the page.
//
// Claude Code's own login is an OAuth PKCE flow: it opens claude.com in the
// browser and catches the redirect on a loopback port. This does the same
// with the same client, so the result is a login Claude Code accepts — the
// alternative was telling the user to run `claude /login` in a terminal.
//
// One flow at a time, held in module state: it lives between the
// `loginStart` call that opens the browser and the `loginPoll` that collects
// the result.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClaudeOauth } from "./host-credentials";

const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];
const FLOW_TIMEOUT_MS = 10 * 60_000;

export interface LoginOutcome {
  credentials: ClaudeOauth;
  oauthAccount: Record<string, unknown>;
  email: string | null;
}

export type LoginState =
  | { status: "idle" }
  | { status: "pending"; url: string }
  | { status: "done"; outcome: LoginOutcome }
  | { status: "failed"; message: string };

function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font:16px system-ui;padding:3rem;text-align:center">
<p>Signed in. Close this tab and go back to BB.</p>`;

const FAIL_PAGE = `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<body style="font:16px system-ui;padding:3rem;text-align:center">
<p>Sign-in failed. Go back to BB and try again.</p>`;

interface Flow {
  server: Server;
  timer: NodeJS.Timeout;
  state: LoginState;
}

let flow: Flow | null = null;

function finish(state: LoginState): void {
  if (flow === null) return;
  clearTimeout(flow.timer);
  flow.server.close();
  flow.state = state;
}

async function exchange(
  code: string,
  verifier: string,
  state: string,
  redirectUri: string,
): Promise<LoginOutcome> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Anthropic rejected the authorization code."
        : `Token exchange failed (HTTP ${response.status}).`,
    );
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.access_token !== "string") {
    throw new Error("Token response was malformed.");
  }
  const expiresIn =
    typeof payload.expires_in === "number" ? payload.expires_in : null;
  const credentials: ClaudeOauth = {
    accessToken: payload.access_token,
    refreshToken: str(payload.refresh_token),
    expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1000,
    scopes:
      typeof payload.scope === "string" ? payload.scope.split(" ") : SCOPES,
    subscriptionType: str(payload.subscription_type),
  };

  // The profile carries the identity ~/.claude.json holds; the token
  // response only names the account in some flows.
  let profile: unknown = null;
  try {
    const profileResponse = await fetch(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (profileResponse.ok) profile = await profileResponse.json();
  } catch {
    profile = null;
  }
  const source = isRecord(profile) ? profile : payload;
  const account = isRecord(source.account) ? source.account : {};
  const organization = isRecord(source.organization) ? source.organization : {};
  const email = str(account.email) ?? str(account.email_address);
  const oauthAccount: Record<string, unknown> = {
    accountUuid: str(account.uuid),
    emailAddress: email,
    organizationUuid: str(organization.uuid),
    organizationName: str(organization.name),
    organizationRole: str(organization.organization_role),
    displayName: str(account.display_name) ?? str(account.full_name) ?? email,
    fullName: str(account.full_name),
    seatTier: str(organization.seat_tier) ?? str(account.seat_tier),
    profileFetchedAt: Date.now(),
  };
  return { credentials, oauthAccount, email };
}

/** Opens the browser and starts listening for the redirect. */
export async function startLogin(): Promise<{ url: string }> {
  cancelLogin();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  const server = createServer();
  const current: Flow = {
    server,
    timer: setTimeout(() => {
      finish({ status: "failed", message: "Sign-in timed out." });
    }, FLOW_TIMEOUT_MS),
    state: { status: "pending", url: "" },
  };
  flow = current;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://localhost:${port}/callback`;

  server.on("request", (request, response) => {
    const requested = new URL(request.url ?? "/", redirectUri);
    if (requested.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = requested.searchParams.get("code");
    const returned = requested.searchParams.get("state");
    if (code === null || returned !== state) {
      response.writeHead(400, { "Content-Type": "text/html" }).end(FAIL_PAGE);
      finish({
        status: "failed",
        message:
          code === null
            ? "The browser came back without an authorization code."
            : "The browser came back with a mismatched state.",
      });
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" }).end(DONE_PAGE);
    exchange(code, verifier, state, redirectUri).then(
      (outcome) => finish({ status: "done", outcome }),
      (cause: unknown) =>
        finish({
          status: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    );
  });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", CLIENT_ID);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", redirectUri);
  url.searchParams.append("scope", SCOPES.join(" "));
  url.searchParams.append("code_challenge", challenge);
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", state);
  const href = url.toString();
  current.state = { status: "pending", url: href };

  if (process.platform === "darwin") {
    execFile("open", [href], () => {
      // The page shows the link too, so a failed `open` is not fatal.
    });
  }
  return { url: href };
}

export function loginState(): LoginState {
  return flow?.state ?? { status: "idle" };
}

/** Clears a finished or abandoned flow. */
export function cancelLogin(): void {
  if (flow === null) return;
  clearTimeout(flow.timer);
  flow.server.close();
  flow = null;
}
