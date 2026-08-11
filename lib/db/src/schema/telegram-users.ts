import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const telegramUsers = pgTable("telegram_users", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  username: text("username"),
  phoneNumber: text("phone_number").notNull(),
  languageCode: text("language_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TelegramUser = typeof telegramUsers.$inferSelect;
export type NewTelegramUser = typeof telegramUsers.$inferInsert;
