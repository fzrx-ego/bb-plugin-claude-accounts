// Limits for the other providers BB is logged into (Cursor, Codex, …).
//
// These come from BB's own provider state, not from a snapshot: the plugin
// reads what BB already knows and never touches those logins.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ProviderCard, Usage } from "../schema";

/** Claude is switchable above, so its card is not repeated in this block. */
const EXCLUDED = new Set(["claude-code"]);

function clampPercent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

export async function listProviderCards(
  bb: BbPluginApi,
  hostId: string | null,
): Promise<ProviderCard[]> {
  const states = await bb.sdk.system.providerStates(
    hostId === null ? {} : { hostId },
  );
  return states.providers
    .filter(
      (provider) =>
        !EXCLUDED.has(provider.providerId) &&
        provider.status !== "not_installed",
    )
    .map((provider) => ({
      providerId: provider.providerId,
      displayName: provider.displayName,
      accountEmail: provider.accountEmail,
      planLabel: provider.planLabel,
    }));
}

export async function providerUsage(
  bb: BbPluginApi,
  providerId: string,
  hostId: string | null,
): Promise<Usage> {
  const response = await bb.sdk.system.usageLimits(
    hostId === null ? { providerId } : { providerId, hostId },
  );
  const entry = response[providerId];
  if (entry === undefined) {
    return { status: "error", message: "BB reported no usage for this provider." };
  }
  switch (entry.status) {
    case "ok":
      return {
        status: "ok",
        accountEmail: entry.accountEmail ?? null,
        planLabel: entry.planLabel ?? null,
        windows: entry.windows.map((window) => ({
          label: window.label,
          usedPercent: clampPercent(window.usedPercent),
          resetsAt: window.resetsAt ?? null,
        })),
      };
    case "error":
      return { status: "error", message: entry.message };
    case "expired":
      return { status: "expired" };
    case "unauthenticated":
      return { status: "unauthenticated" };
    default:
      return { status: "not_installed" };
  }
}
