// Host RPC contract: everything that touches the Keychain, ~/.claude.json,
// or the Anthropic usage endpoint runs in the host worker, never on the
// server.

import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { codexAccountSchema, codexIdentitySchema, codexStateSchema, machineStateSchema, savedAccountSchema, usageSchema } from "./schema";

export const hostContract = defineRpcContract({
  codexState: { input: z.null(), output: codexStateSchema },
  codexSave: { input: z.object({ label: z.string().trim().min(1).max(60) }).strict(), output: z.object({ account: codexAccountSchema }).strict() },
  codexSwitch: { input: z.object({ id: z.string() }).strict(), output: z.object({ account: codexAccountSchema }).strict() },
  codexForget: { input: z.object({ id: z.string() }).strict(), output: z.object({ removed: z.boolean() }).strict() },
  codexUsage: { input: z.object({ id: z.string() }).strict(), output: z.object({ usage: usageSchema }).strict() },
  codexLoginStart: { input: z.null(), output: z.object({ started: z.boolean() }).strict() },
  codexLoginPoll: { input: z.null(), output: z.object({
    status: z.enum(["idle", "pending", "done", "failed"]),
    message: z.string().nullable(),
    account: codexIdentitySchema.nullable(),
  }).strict() },
  codexLoginCancel: { input: z.null(), output: z.object({ cancelled: z.boolean() }).strict() },
  state: {
    input: z.null(),
    output: machineStateSchema,
  },
  save: {
    input: z.object({ label: z.string().trim().min(1).max(60) }).strict(),
    output: z.object({ account: savedAccountSchema }).strict(),
  },
  rename: {
    input: z
      .object({ id: z.string(), label: z.string().trim().min(1).max(60) })
      .strict(),
    output: z.object({ account: savedAccountSchema }).strict(),
  },
  forget: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  switchTo: {
    input: z.object({ id: z.string() }).strict(),
    output: z
      .object({ account: savedAccountSchema, savedPrevious: z.boolean() })
      .strict(),
  },
  usage: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ usage: usageSchema }).strict(),
  },
  loginStart: {
    input: z.null(),
    output: z.object({ url: z.string() }).strict(),
  },
  loginPoll: {
    input: z.null(),
    output: z
      .object({
        status: z.enum(["idle", "pending", "done", "failed"]),
        url: z.string().nullable(),
        account: savedAccountSchema.nullable(),
        message: z.string().nullable(),
      })
      .strict(),
  },
  loginCancel: {
    input: z.null(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
});

export const hostSignals = {
  changed: {
    payload: z.object({ reason: z.string() }).strict(),
  },
} satisfies ExperimentalHostSignals;
