// Anthropic usage for one saved snapshot, read with that snapshot's own
// token so the active login is never disturbed. Mirrors the shape BB's
// Claude provider reports, so the page can show the same windows.

import type { Usage, UsageWindow } from "../schema";
import type { ClaudeOauth } from "./host-credentials";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 15_000;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resetIso(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function window_(
  value: unknown,
  label: string,
): UsageWindow | null {
  if (!isRecord(value) || typeof value.utilization !== "number") return null;
  return {
    label,
    usedPercent: clampPercent(value.utilization),
    resetsAt: resetIso(value.resets_at),
  };
}

/** Per-model weekly limits Anthropic reports beside the two main windows. */
function scopedWindows(limits: unknown): UsageWindow[] {
  if (!Array.isArray(limits)) return [];
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const limit of limits) {
    if (!isRecord(limit) || limit.kind !== "weekly_scoped") continue;
    const scope = isRecord(limit.scope) ? limit.scope : null;
    const model = scope !== null && isRecord(scope.model) ? scope.model : null;
    const label = model === null ? null : model.display_name;
    if (typeof label !== "string" || typeof limit.percent !== "number") continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({
      label,
      usedPercent: clampPercent(limit.percent),
      resetsAt: resetIso(limit.resets_at),
    });
  }
  return windows;
}

export function planLabel(credentials: ClaudeOauth): string | null {
  const max = (credentials.rateLimitTier ?? "").match(/max_(\d+)x/u);
  if (max !== null) return `Max (${max[1]}x)`;
  const subscription = credentials.subscriptionType;
  if (typeof subscription !== "string" || subscription === "") return null;
  return subscription.charAt(0).toUpperCase() + subscription.slice(1);
}

export async function fetchUsage(
  credentials: ClaudeOauth,
  accountEmail: string | null,
  signal?: AbortSignal,
): Promise<Usage> {
  if (
    credentials.expiresAt !== null &&
    credentials.expiresAt !== undefined &&
    Date.now() >= credentials.expiresAt
  ) {
    return { status: "expired" };
  }
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401) return { status: "expired" };
    if (!response.ok) {
      return {
        status: "error",
        message:
          response.status === 429
            ? "Anthropic throttled this usage check. It does not mean the limit is spent — try again later."
            : `Usage request failed (HTTP ${response.status}).`,
      };
    }
    const raw: unknown = await response.json();
    if (!isRecord(raw)) {
      return { status: "error", message: "Usage response was malformed." };
    }
    const windows = [
      window_(raw.five_hour, "Current session"),
      window_(raw.seven_day, "Weekly limit"),
      ...scopedWindows(raw.limits),
    ].filter((entry): entry is UsageWindow => entry !== null);
    return {
      status: "ok",
      accountEmail,
      planLabel: planLabel(credentials),
      windows,
    };
  } catch (cause) {
    return {
      status: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
