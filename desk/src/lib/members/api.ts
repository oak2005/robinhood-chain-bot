import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";

const slotInput = z.object({
  chain: z.enum(["solana", "stacks", "robinhood"]),
  privateKey: z.string().min(32).max(400),
  token: z.string().min(8).max(140),
  symbol: z.string().max(16),
  interval: z.enum(["10m", "20m", "30m", "1h"]),
  freshAck: z.literal(true),
});

export const getAccess = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const desk = await import("./desk.server");
    return desk.loadAccess(context.userId);
  });

export const addSlot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(slotInput)
  .handler(async ({ data, context }) => {
    const desk = await import("./desk.server");
    return desk.addSlot(context.userId, data);
  });

export const removeSlot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ slotId: z.string().min(8).max(80) }))
  .handler(async ({ data, context }) => {
    const desk = await import("./desk.server");
    return desk.removeSlot(context.userId, data.slotId);
  });

export const confirmPayment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      chain: z.enum(["solana", "base", "bsc"]),
      txHash: z.string().min(32).max(140),
    }),
  )
  .handler(async ({ data, context }) => {
    const desk = await import("./desk.server");
    return desk.confirmPayment(context.userId, data.chain, data.txHash);
  });

export const operatorBoard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const desk = await import("./desk.server");
    return desk.loadOperatorBoard(context.userId);
  });
