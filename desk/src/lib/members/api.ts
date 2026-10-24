import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";

const slotInput = z.object({
  chain: z.enum(["solana", "stacks", "robinhood"]),
  privateKey: z.string().min(32).max(400),
  token: z.string().min(8).max(140),
  symbol: z.string().max(16),
  interval: z.enum(["10m", "20m", "30m", "1h"]),
  tradeRange: z.enum(["5-20", "21-50", "51-100", "100+"]).optional(),
  freshAck: z.literal(true),
});

export const createUniversalWallet = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    const { generateUniversalWallet } = await import("./keys");
    return generateUniversalWallet();
  });

export const restoreUniversalWallet = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ mnemonic: z.string().min(10).max(500) }))
  .handler(async ({ data }) => {
    const { deriveUniversalWallet } = await import("./keys");
    return deriveUniversalWallet(data.mnemonic);
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
      chain: z.enum(["solana", "base", "bsc", "robinhood"]),
      txHash: z.string().min(32).max(140),
    }),
  )
  .handler(async ({ data, context }) => {
    const desk = await import("./desk.server");
    return desk.confirmPayment(context.userId, data.chain, data.txHash);
  });

export const raiseDispute = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      chain: z.enum(["solana", "base", "bsc", "robinhood"]),
      txHash: z.string().min(32).max(140),
      userNote: z.string().max(500).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const desk = await import("./desk.server");
    return desk.createDispute(context.userId, data);
  });

export const getUserDisputes = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const desk = await import("./desk.server");
    return desk.loadUserDisputes(context.userId);
  });

export const resolveDispute = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      disputeId: z.string().min(4).max(60),
      action: z.enum(["accept", "reject"]),
      adminNote: z.string().max(500).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const desk = await import("./desk.server");
    return desk.resolveDispute(context.userId, data.disputeId, data.action, data.adminNote);
  });

export const operatorBoard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const desk = await import("./desk.server");
    return desk.loadOperatorBoard(context.userId);
  });

