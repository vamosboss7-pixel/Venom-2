import { bigint, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { telegramUsers } from "./telegram-users";

export const walletTransactionType = pgEnum("wallet_transaction_type", ["deposit", "withdrawal", "bingo_payout", "adjustment"]);
export const walletTransactionStatus = pgEnum("wallet_transaction_status", ["pending", "completed", "failed", "reversed"]);

export const walletTransactions = pgTable("wallet_transactions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().references(() => telegramUsers.telegramId),
  type: walletTransactionType("type").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  balanceBefore: numeric("balance_before", { precision: 14, scale: 2 }).notNull(),
  balanceAfter: numeric("balance_after", { precision: 14, scale: 2 }).notNull(),
  status: walletTransactionStatus("status").notNull().default("pending"),
  reference: text("reference"),
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ referenceUnique: uniqueIndex("wallet_transactions_reference_idx").on(table.reference) }));

export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
