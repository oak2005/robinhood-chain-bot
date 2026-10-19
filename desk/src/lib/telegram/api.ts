import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const snapshotSchema = z.object({
  adminId: z.string().max(20),
  pair: z.string().max(24),
  status: z.string().max(40),
  balance: z.string().max(500),
  interval: z.string().max(8),
  dryRun: z.boolean(),
  tradingEnabled: z.boolean(),
  active: z.boolean(),
  halted: z.boolean(),
  pending: z.string().max(600).nullable(),
  historyText: z.string().max(2000),
  equityText: z.string().max(500),
  quoteText: z.string().max(500),
  statusText: z.string().max(1000),
});

const replySchema = z.object({
  updateId: z.number().int(),
  chatId: z.number().int().optional(),
  text: z.string().max(3500),
  keyboard: z.enum(["interval"]).optional(),
});

export const syncDesk = createServerFn({ method: "POST" })
  .validator(
    z.object({
      snapshot: snapshotSchema,
      replies: z.array(replySchema).max(8),
      ack: z.array(z.number().int()).max(20),
    }),
  )
  .handler(async ({ data }) => {
    const hub = await import("./hub.server");
    return hub.hubSync(data);
  });

export const connectRobinhood = createServerFn({ method: "POST" })
  .validator(
    z.object({
      apiKey: z.string().min(8).max(180),
      privateKey: z.string().min(20).max(180),
    }),
  )
  .handler(async ({ data }) => {
    const hub = await import("./hub.server");
    return hub.saveCredentials(data.apiKey, data.privateKey);
  });

export const disconnectRobinhood = createServerFn({ method: "POST" })
  .validator(z.object({}))
  .handler(async () => {
    const hub = await import("./hub.server");
    return hub.eraseCredentials();
  });
