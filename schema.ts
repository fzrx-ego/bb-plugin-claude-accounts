// Shared shapes for the server, the host worker, and the page.
//
// Tokens never appear here: a snapshot's credentials stay in the host
// credential store (Keychain on macOS, DPAPI files on Windows), and only
// these fields cross an RPC boundary.

import { z } from "zod";

export const identitySchema = z.object({
  accountUuid: z.string().nullable(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  organizationName: z.string().nullable(),
  organizationUuid: z.string().nullable(),
  subscriptionType: z.string().nullable(),
});
export type Identity = z.infer<typeof identitySchema>;

export const savedAccountSchema = identitySchema.extend({
  /** Stable key of the snapshot; also the Keychain account attribute. */
  id: z.string(),
  label: z.string(),
  savedAt: z.number(),
});
export type SavedAccount = z.infer<typeof savedAccountSchema>;

export const machineStateSchema = z.object({
  /** Claude Code identity currently active on the machine. */
  active: identitySchema.nullable(),
  /** A snapshot id matching the active identity, when one is saved. */
  activeId: z.string().nullable(),
  /** The machine has usable Claude credentials right now. */
  hasCredentials: z.boolean(),
  /** `claude` resolves on the host PATH. */
  cliInstalled: z.boolean(),
  accounts: z.array(savedAccountSchema),
});
export type MachineState = z.infer<typeof machineStateSchema>;

export const codexAccountSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  label: z.string(),
  savedAt: z.number(),
});
export type CodexAccount = z.infer<typeof codexAccountSchema>;

export const codexIdentitySchema = z.object({ id: z.string(), email: z.string().nullable() });
export type CodexIdentity = z.infer<typeof codexIdentitySchema>;

export const codexStateSchema = z.object({
  activeId: z.string().nullable(),
  activeEmail: z.string().nullable(),
  activeError: z.string().nullable(),
  accounts: z.array(codexAccountSchema),
});
export type CodexState = z.infer<typeof codexStateSchema>;

export const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    windows: z.array(usageWindowSchema),
  }),
  z.object({ status: z.literal("unauthenticated") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("not_installed") }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type Usage = z.infer<typeof usageSchema>;

/** One card in the "Other providers" block: limits only, no switching. */
export const providerCardSchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
});
export type ProviderCard = z.infer<typeof providerCardSchema>;

export const hostInfoSchema = z.object({
  hostId: z.string().nullable(),
  platform: z.string().nullable(),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;
