import { and, asc, eq, inArray } from "drizzle-orm";
import { db, bingoCalls, bingoPlayerCards, bingoRounds, telegramUsers } from "@workspace/db";
import { Router, type IRouter, type Request } from "express";
import { isValidTelegramInitData, parseTelegramUser } from "./telegram";
import { logger } from "../lib/logger";
import { awardBingoPayout } from "../lib/payout";

const router: IRouter = Router();
const MAX_CARDS = 4;
const CARD_COUNT = 150;
const DEFAULT_BINGO_PAYOUT = "2280.00";

function getBingoPayoutAmount() {
  const configured = process.env["BINGO_PAYOUT_AMOUNT"]?.trim();
  return configured && /^\d+(?:\.\d{1,2})?$/.test(configured) ? Number(configured).toFixed(2) : DEFAULT_BINGO_PAYOUT;
}

function winnerCard(grid: Array<number | "star">, called: Set<number>) {
  const marked = (cell: number | "star") => cell === "star" || called.has(cell as number);
  const lines = [
    [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14],
    [15, 16, 17, 18, 19], [20, 21, 22, 23, 24], [0, 5, 10, 15, 20],
    [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23],
    [4, 9, 14, 19, 24], [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
  ];
  const corners = [0, 4, 20, 24];
  return lines.some((line) => line.every((index) => marked(grid[index]!))) || corners.every((index) => marked(grid[index]!));
}

async function resolveRoundWinner(roundId: number, calls: Array<{ number: number }>, cards: Array<{ id: number; telegramId: number; cardNumber: number; grid: Array<number | "star"> }>) {
  const called = new Set(calls.map((call) => call.number));
  const winner = [...cards].sort((left, right) => left.id - right.id).find((card) => winnerCard(card.grid, called));
  if (!winner) return undefined;
  const result = await awardBingoPayout({ roundId, cardId: winner.id, telegramId: winner.telegramId, amount: getBingoPayoutAmount() });
  const player = await db.query.telegramUsers.findFirst({ where: eq(telegramUsers.telegramId, winner.telegramId), columns: { firstName: true, lastName: true } });
  return { telegramId: winner.telegramId, name: [player?.firstName, player?.lastName].filter(Boolean).join(" "), cardNumber: winner.cardNumber, payout: result.payout.amount, status: result.payout.status };
}

function shuffledNumbers() {
  const values = Array.from({ length: 75 }, (_, index) => index + 1);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

function buildCard(cardNumber: number): Array<number | "star"> {
  let seed = cardNumber * 9301 + 49297;
  const random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const columns: number[][] = [];
  for (let column = 0; column < 5; column += 1) {
    const pool = Array.from({ length: 15 }, (_, index) => column * 15 + index + 1);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    columns.push(pool.slice(0, 5));
  }
  return Array.from({ length: 25 }, (_, index) => index === 12 ? "star" : columns[index % 5][Math.floor(index / 5)]);
}

export async function ensureActiveBingoRound() {
  const active = await db.query.bingoRounds.findFirst({ where: eq(bingoRounds.status, "active"), orderBy: [asc(bingoRounds.id)] });
  if (active) return active;
  const [created] = await db.insert(bingoRounds).values({ status: "active" }).returning();
  if (!created) throw new Error("Could not create Bingo round");
  return created;
}

export async function advanceBingoRound() {
  const round = await ensureActiveBingoRound();
  const calls = await db.query.bingoCalls.findMany({ where: eq(bingoCalls.roundId, round.id), orderBy: [asc(bingoCalls.position)] });
  if (calls.length >= 75) {
    await db.update(bingoRounds).set({ status: "completed", completedAt: new Date() }).where(and(eq(bingoRounds.id, round.id), eq(bingoRounds.status, "active")));
    return ensureActiveBingoRound();
  }
  const remaining = shuffledNumbers().filter((number) => !calls.some((call) => call.number === number));
  await db.insert(bingoCalls).values({ roundId: round.id, number: remaining[0]!, position: calls.length });
  return round;
}

async function authenticatedUser(req: Request) {
  const initData = req.header("x-telegram-init-data") ?? req.header("authorization")?.replace(/^tma\s+/i, "");
  const token = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  if (!initData || !token || !isValidTelegramInitData(initData, token)) return undefined;
  const user = parseTelegramUser(initData);
  if (!user) return undefined;
  return db.query.telegramUsers.findFirst({ where: eq(telegramUsers.telegramId, user.id) });
}

router.get("/bingo/round", async (_req, res) => {
  try {
    const round = await ensureActiveBingoRound();
    const [calls, cards] = await Promise.all([
      db.query.bingoCalls.findMany({ where: eq(bingoCalls.roundId, round.id), orderBy: [asc(bingoCalls.position)] }),
      db.query.bingoPlayerCards.findMany({ where: eq(bingoPlayerCards.roundId, round.id), columns: { id: true, telegramId: true, cardNumber: true, grid: true } }),
    ]);
    const winner = await resolveRoundWinner(round.id, calls, cards);
    res.json({ id: round.id, status: round.status, startedAt: round.startedAt, calls: calls.map((call) => ({ number: call.number, position: call.position, calledAt: call.calledAt })), takenCardNumbers: cards.map((card) => card.cardNumber), winner });
  } catch (error) {
    logger.error({ err: error }, "Failed to load Bingo round");
    res.status(503).json({ error: "Bingo round unavailable" });
  }
});

router.get("/bingo/cards", async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) { res.status(401).json({ error: "Valid Telegram authentication is required" }); return; }
  const round = await ensureActiveBingoRound();
  const cards = await db.query.bingoPlayerCards.findMany({ where: and(eq(bingoPlayerCards.roundId, round.id), eq(bingoPlayerCards.telegramId, user.telegramId)), orderBy: [asc(bingoPlayerCards.cardNumber)] });
  res.json({ roundId: round.id, cards });
});

router.post("/bingo/cards", async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) { res.status(401).json({ error: "Valid Telegram authentication is required" }); return; }
  const cardNumbers = req.body?.cardNumbers;
  if (!Array.isArray(cardNumbers) || cardNumbers.length < 1 || cardNumbers.length > MAX_CARDS || new Set(cardNumbers).size !== cardNumbers.length || cardNumbers.some((value) => !Number.isInteger(value) || value < 1 || value > CARD_COUNT)) {
    res.status(400).json({ error: `Choose between 1 and ${MAX_CARDS} unique cards from 1 to ${CARD_COUNT}` }); return;
  }
  const round = await ensureActiveBingoRound();
  const existing = await db.query.bingoPlayerCards.findMany({ where: and(eq(bingoPlayerCards.roundId, round.id), inArray(bingoPlayerCards.cardNumber, cardNumbers)), columns: { cardNumber: true, telegramId: true } });
  const takenByOther = existing.find((card) => card.telegramId !== user.telegramId);
  if (takenByOther) { res.status(409).json({ error: `Card ${takenByOther.cardNumber} is already taken` }); return; }
  const current = await db.query.bingoPlayerCards.findMany({ where: and(eq(bingoPlayerCards.roundId, round.id), eq(bingoPlayerCards.telegramId, user.telegramId)), columns: { cardNumber: true } });
  if (current.length + cardNumbers.filter((number) => !current.some((card) => card.cardNumber === number)).length > MAX_CARDS) { res.status(400).json({ error: `You can select at most ${MAX_CARDS} cards` }); return; }
  const missing = cardNumbers.filter((number) => !current.some((card) => card.cardNumber === number));
  if (missing.length) await db.insert(bingoPlayerCards).values(missing.map((cardNumber) => ({ roundId: round.id, telegramId: user.telegramId, cardNumber, grid: buildCard(cardNumber) })));
  const cards = await db.query.bingoPlayerCards.findMany({ where: and(eq(bingoPlayerCards.roundId, round.id), eq(bingoPlayerCards.telegramId, user.telegramId)), orderBy: [asc(bingoPlayerCards.cardNumber)] });
  res.status(201).json({ roundId: round.id, cards });
});

export function startBingoRoundInterval() {
  const globalState = globalThis as typeof globalThis & { __bingoInterval?: ReturnType<typeof setInterval> };
  if (globalState.__bingoInterval) return;
  globalState.__bingoInterval = setInterval(() => { void advanceBingoRound().catch((error) => logger.error({ err: error }, "Bingo round tick failed")); }, 3_000);
  void ensureActiveBingoRound().catch((error) => logger.error({ err: error }, "Bingo round startup failed"));
}

export default router;
