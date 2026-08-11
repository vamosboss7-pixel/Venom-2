import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  depositRequests,
  telegramUsers,
  walletTransactions,
  withdrawalRequests,
} from "@workspace/db";
import { Router, type IRouter, type Request } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const AUTH_DATA_MAX_AGE_SECONDS = 86_400;

type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

type TelegramUpdate = {
  message?: {
    chat: { id: number };
    text?: string;
    from?: TelegramUser;
    contact?: {
      phone_number: string;
      user_id?: number;
      first_name: string;
      last_name?: string;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: TelegramUser;
    message?: { chat: { id: number }; message_id: number };
  };
};

type TelegramAuthPayload = {
  initData?: unknown;
};

type DepositSession =
  | { step: "payment-method" }
  | { step: "amount" }
  | { step: "transaction-id"; amount: number };

type WithdrawalSession =
  | { step: "amount" }
  | { step: "phone"; amount: number }
  | { step: "owner-name"; amount: number; phone: string };

const depositSessions = new Map<number, DepositSession>();
const withdrawalSessions = new Map<number, WithdrawalSession>();
const TELEBIRR_ACCOUNT_NAME = "ካሸሪ dawit";
const TELEBIRR_ACCOUNT_NUMBER = "0964846006";

function getBotToken() {
  const value = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  return value || undefined;
}

function getWebAppUrl() {
  const value = process.env["TELEGRAM_WEB_APP_URL"]?.trim();
  if (!value) return undefined;
  return value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `https://${value}`;
}

function getWebhookSecret() {
  const value = process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim();
  if (!value) return undefined;
  if (/^[A-Za-z0-9_-]{1,256}$/.test(value)) return value;
  return createHash("sha256").update(value).digest("hex");
}

function getAdminChatId() {
  const value = Number(process.env["TELEGRAM_ADMIN_CHAT_ID"]?.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

function getWebhookUrl() {
  const baseUrl = (process.env["TELEGRAM_WEBHOOK_URL"] ?? process.env["RENDER_EXTERNAL_URL"])?.trim();
  if (!baseUrl) return undefined;
  const normalizedBaseUrl = baseUrl.startsWith("http://") || baseUrl.startsWith("https://")
    ? baseUrl
    : `https://${baseUrl}`;
  return new URL("/api/telegram/webhook", normalizedBaseUrl).toString();
}

async function telegramRequest<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = getBotToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");

  const response = await fetch(`${TELEGRAM_API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description ?? response.statusText}`);
  }
  return result.result as T;
}

function isTelegramWebhookRequest(req: Request) {
  const expectedSecret = getWebhookSecret();
  return Boolean(expectedSecret) && req.header("x-telegram-bot-api-secret-token") === expectedSecret;
}

export function isValidTelegramInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!receivedHash || !Number.isSafeInteger(authDate)) return false;
  if (Math.abs(Date.now() / 1000 - authDate) > AUTH_DATA_MAX_AGE_SECONDS) return false;

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const receivedHashBuffer = Buffer.from(receivedHash, "hex");
  const calculatedHashBuffer = Buffer.from(calculatedHash, "hex");
  return receivedHashBuffer.length === calculatedHashBuffer.length && timingSafeEqual(receivedHashBuffer, calculatedHashBuffer);
}

export function parseTelegramUser(initData: string) {
  const userValue = new URLSearchParams(initData).get("user");
  if (!userValue) return undefined;
  try {
    return JSON.parse(userValue) as TelegramUser;
  } catch {
    return undefined;
  }
}

function getMainKeyboard() {
  return {
    keyboard: [
      [{ text: "📝 Register", request_contact: true }, { text: "🎮 Play Bingo" }],
      [{ text: "🎁 Promo Code" }, { text: "💰 Deposit" }],
      [{ text: "💸 Withdraw" }, { text: "🔗 Invite & Earn" }],
      [{ text: "👤 Profile & Account" }, { text: "🆘 Support" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getContactKeyboard() {
  return {
    keyboard: [[{ text: "📱 ኮንታክት ላክ", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function getPaymentMethodKeyboard() {
  return {
    inline_keyboard: [[{ text: "ቴሌብር", callback_data: "deposit:telebirr" }]],
  };
}

async function sendWelcomeMessage(chatId: number, firstName?: string) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: `🎉 እንኳን ወደ Flash Bingo በደህና መጡ${firstName ? ` ${firstName}` : ""}! 🎰\n\nለመመዝገብ "📝 Register" የሚለውን ይጫኑ።\n\nከታች ያለውን ምናሌ በመጠቀም ጨዋታውን ይጀምሩ።`,
    reply_markup: getMainKeyboard(),
  });
}

async function sendContactPrompt(chatId: number) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "ምዝገባን ለመጨረስ ከታች ያለውን ቁልፍ በመጫን የራስዎን Telegram contact ያጋሩ።",
    reply_markup: getContactKeyboard(),
  });
}

async function sendProfileAccountMessage(chatId: number, telegramId?: number) {
  const user = telegramId
    ? await db.query.telegramUsers.findFirst({ where: eq(telegramUsers.telegramId, telegramId) })
    : undefined;
  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "*****";
  const phone = user?.phoneNumber ? `${user.phoneNumber.slice(0, 2)}****` : "09****";
  const playWallet = user?.playWalletBalance ?? "0.00";
  const winWallet = user?.winWalletBalance ?? "0.00";

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: `👤 Profile & Account\n\n👤 ፕሮፋይል\n\nስም: ${name}\nስልክ: ${phone}\n\n💰 play wallet : ${playWallet} ETB\n🏆 win wallet : ${winWallet} ETB`,
    reply_markup: getMainKeyboard(),
  });
}

async function sendInviteMessage(chatId: number) {
  const bot = await telegramRequest<{ username?: string }>("getMe", {});
  if (!bot.username) {
    logger.error("Telegram bot username is not available");
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: "የመጋበዣ ሊንክ ማመንጨት አልተቻለም። እባክዎ ቆይተው ይሞክሩ።",
    });
    return;
  }

  const inviteLink = new URL(`https://t.me/${bot.username}`);
  inviteLink.searchParams.set("start", `re${chatId}`);
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: `🎉 ጋብዝ & አግኝ!\n\nጓደኞችዎን ይጋብዙ እና ለእያንዳንዱ ለጋበዙት ሰው የ20 ብር የPlay Wallet ስጦታ ያግኙ!\n\nየእርስዎ መጋበዣ ሊንክ፦\n${inviteLink.toString()}`,
    reply_markup: getMainKeyboard(),
  });
}

async function sendWithdrawalAmountPrompt(chatId: number) {
  withdrawalSessions.set(chatId, { step: "amount" });
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "እባክዎን ማውጣት የሚፈልጉትን መጠን ከ100 ብር ጀምሮ ያስገቡ",
  });
}

async function sendWithdrawalPhonePrompt(chatId: number, amount: number) {
  withdrawalSessions.set(chatId, { step: "phone", amount });
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "ገንዘብ የሚቀበሉበትን የቴሌብር ቁጥር ያስገቡ",
  });
}

async function sendWithdrawalOwnerNamePrompt(chatId: number, amount: number, phone: string) {
  withdrawalSessions.set(chatId, { step: "owner-name", amount, phone });
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "የአካውንቱ ባለቤት ስም ያስገቡ",
  });
}

async function submitWithdrawalRequest(
  chatId: number,
  user: TelegramUser | undefined,
  amount: number,
  phone: string,
  ownerName: string,
) {
  const telegramId = user?.id;
  if (!telegramId) {
    await telegramRequest("sendMessage", { chat_id: chatId, text: "መጀመሪያ እባክዎ ይመዝገቡ።" });
    return;
  }
  const [request] = await db.insert(withdrawalRequests).values({
    telegramId,
    amount: amount.toFixed(2),
    phone,
    ownerName,
    status: "pending",
  }).onConflictDoNothing({ target: [withdrawalRequests.telegramId, withdrawalRequests.amount, withdrawalRequests.phone, withdrawalRequests.ownerName] }).returning({ id: withdrawalRequests.id });
  if (!request) {
    await telegramRequest("sendMessage", { chat_id: chatId, text: "ይህ የወጪ ጥያቄ ቀድሞ ተመዝግቧል።" });
    withdrawalSessions.delete(chatId);
    return;
  }
  const adminChatId = getAdminChatId();
  if (adminChatId) await telegramRequest("sendMessage", {
    chat_id: adminChatId,
    text: `💸 አዲስ የወጪ ጥያቄ\n\nተጠቃሚ: ${user?.first_name ?? "Unknown"}${user?.username ? ` (@${user.username})` : ""}\nTelegram ID: ${user?.id ?? "Unknown"}\nChat ID: ${chatId}\nመጠን: ${amount} ETB\nTelebirr ቁጥር: ${phone}\nየአካውንት ባለቤት: ${ownerName}`,
  });
  withdrawalSessions.delete(chatId);
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "እንኳን ደስ አልዎት የወጪ ጥያቄዎ ወደ አድሚን ተልኳል።\nየቴሌብር መልዕክት በቅርቡ ይደርስዎታል።",
    reply_markup: getMainKeyboard(),
  });
}

async function sendDepositPaymentOptions(chatId: number) {
  depositSessions.set(chatId, { step: "payment-method" });
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "💰 ሂሳብ ለመሙላት የሚጠቀሙበትን የክፍያ አማራጭ ይምረጡ፦",
    reply_markup: getPaymentMethodKeyboard(),
  });
}

async function sendTelebirrAmountPrompt(chatId: number) {
  depositSessions.set(chatId, { step: "amount" });
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "ቴሌብርን መርጠዋል\n\nእባክዎ መሙላት የሚፈልጉትን የገንዘብ መጠን በቁጥር ብቻ ያስገቡ (ከ 10 ብር ጀምሮ):",
  });
}

async function sendTelebirrPaymentInstructions(chatId: number, amount: number) {
  depositSessions.set(chatId, { step: "transaction-id", amount });
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: `መሙላት የፈለጉት መጠን: ${amount} ETB\n\nእባክዎ ከታች ወዳለው የTelebirr አካውንት ብሩን ያስገቡ።\nስም: ${TELEBIRR_ACCOUNT_NAME}\nአካውንት: ${TELEBIRR_ACCOUNT_NUMBER}\n\nከዚያም የትራንዛክሽን ቁጥሩን (Transaction ID) እዚህ ላይ ይፃፉልን። ጥያቄዎ በአጭር ጊዜ ውስጥ ይስተናገዳል።`,
  });
}

async function submitDepositRequest(chatId: number, user: TelegramUser | undefined, amount: number, transactionId: string) {
  const telegramId = user?.id;
  if (!telegramId) {
    await telegramRequest("sendMessage", { chat_id: chatId, text: "መጀመሪያ እባክዎ ይመዝገቡ።" });
    return;
  }
  const [request] = await db.insert(depositRequests).values({
    telegramId,
    amount: amount.toFixed(2),
    paymentMethod: "telebirr",
    transactionId: transactionId.trim(),
    status: "pending",
  }).onConflictDoNothing({ target: [depositRequests.paymentMethod, depositRequests.transactionId] }).returning({ id: depositRequests.id });
  if (!request) {
    await telegramRequest("sendMessage", { chat_id: chatId, text: "ይህ የTransaction ID ቀድሞ ተመዝግቧል።" });
    depositSessions.delete(chatId);
    return;
  }
  const adminChatId = getAdminChatId();
  if (adminChatId) await telegramRequest("sendMessage", {
    chat_id: adminChatId,
    text: `💰 አዲስ የቴሌብር ዲፖዚት ጥያቄ\n\nተጠቃሚ: ${user?.first_name ?? "Unknown"}${user?.username ? ` (@${user.username})` : ""}\nTelegram ID: ${user?.id ?? "Unknown"}\nChat ID: ${chatId}\nመጠን: ${amount} ETB\nTransaction ID: ${transactionId}`,
  });
  depositSessions.delete(chatId);
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: `✅ የ${amount} ETB የሂሳብ መሙያ ጥያቄዎ ወደአድሚን ተልኳል። አድሚኑ ሲያጸድቀው መልዕክት ይደርስዎታል።`,
    reply_markup: getMainKeyboard(),
  });
}

async function sendMiniAppLink(chatId: number) {
  const webAppUrl = getWebAppUrl();
  if (!webAppUrl) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: "Mini App አሁን ዝግጁ አይደለም። እባክዎ ቆይተው እንደገና ይሞክሩ።",
    });
    return;
  }
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "Flash Bingo ለመክፈት ከታች ያለውን ቁልፍ ይጫኑ።",
    reply_markup: {
      inline_keyboard: [[{ text: "Flash Bingo ክፈት", web_app: { url: webAppUrl } }]],
    },
  });
}

function getAdminApprovalKeyboard(type: "deposit" | "withdrawal", id: number) {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: `${type}:approve:${id}` },
      { text: "Reject", callback_data: `${type}:reject:${id}` },
    ]],
  };
}

async function sendPendingRequests(chatId: number) {
  const [deposits, withdrawals] = await Promise.all([
    db.query.depositRequests.findMany({
      where: eq(depositRequests.status, "pending"),
      orderBy: [desc(depositRequests.createdAt)],
    }),
    db.query.withdrawalRequests.findMany({
      where: eq(withdrawalRequests.status, "pending"),
      orderBy: [desc(withdrawalRequests.createdAt)],
    }),
  ]);

  if (deposits.length === 0 && withdrawals.length === 0) {
    await telegramRequest("sendMessage", { chat_id: chatId, text: "No pending deposit or withdrawal requests." });
    return;
  }

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: `Pending requests: ${deposits.length} deposit(s), ${withdrawals.length} withdrawal(s).`,
  });
  for (const request of deposits) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: `Deposit #${request.id}\nTelegram ID: ${request.telegramId}\nAmount: ${request.amount} ETB\nPayment: ${request.paymentMethod}\nTransaction ID: ${request.transactionId}`,
      reply_markup: getAdminApprovalKeyboard("deposit", request.id),
    });
  }
  for (const request of withdrawals) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: `Withdrawal #${request.id}\nTelegram ID: ${request.telegramId}\nAmount: ${request.amount} ETB\nTelebirr: ${request.phone}\nOwner: ${request.ownerName}`,
      reply_markup: getAdminApprovalKeyboard("withdrawal", request.id),
    });
  }
}

async function notifyWalletRequestUser(telegramId: number, text: string) {
  const user = await db.query.telegramUsers.findFirst({
    where: eq(telegramUsers.telegramId, telegramId),
    columns: { chatId: true },
  });
  if (user) await telegramRequest("sendMessage", { chat_id: user.chatId, text });
}

async function processAdminDecision(type: "deposit" | "withdrawal", action: "approve" | "reject", id: number, adminChatId: number) {
  let outcome = "Request was already processed.";
  let userNotification: { telegramId: number; text: string } | undefined;
  await db.transaction(async (tx) => {
    const request = type === "deposit"
      ? (await tx.select().from(depositRequests).where(and(eq(depositRequests.id, id), eq(depositRequests.status, "pending"))).for("update").limit(1))[0]
      : (await tx.select().from(withdrawalRequests).where(and(eq(withdrawalRequests.id, id), eq(withdrawalRequests.status, "pending"))).for("update").limit(1))[0];
    if (!request) return;

    const user = (await tx.select().from(telegramUsers).where(eq(telegramUsers.telegramId, request.telegramId)).for("update").limit(1))[0];
    if (!user) {
      outcome = "The request user no longer exists.";
      return;
    }
    if (action === "reject") {
      const updatedAt = new Date();
      if (type === "deposit") await tx.update(depositRequests).set({ status: "rejected", updatedAt }).where(and(eq(depositRequests.id, id), eq(depositRequests.status, "pending")));
      else await tx.update(withdrawalRequests).set({ status: "rejected", updatedAt }).where(and(eq(withdrawalRequests.id, id), eq(withdrawalRequests.status, "pending")));
      outcome = `Request #${id} rejected.`;
      userNotification = { telegramId: request.telegramId, text: type === "deposit" ? `Your deposit request #${id} was rejected.` : `Your withdrawal request #${id} was rejected.` };
      return;
    }

    const amount = Number(request.amount);
    const before = Number(type === "deposit" ? user.playWalletBalance : user.winWalletBalance);
    if (type === "withdrawal" && before < amount) {
      await tx.update(withdrawalRequests).set({ status: "rejected", updatedAt: new Date() }).where(and(eq(withdrawalRequests.id, id), eq(withdrawalRequests.status, "pending")));
      outcome = `Withdrawal #${id} rejected: insufficient win wallet balance.`;
      userNotification = { telegramId: request.telegramId, text: `Your withdrawal request #${id} was rejected because your win wallet balance is insufficient.` };
      return;
    }

    const after = type === "deposit" ? before + amount : before - amount;
    const reference = `${type}-request-${id}`;
    await tx.insert(walletTransactions).values({
      telegramId: request.telegramId,
      type,
      amount: request.amount,
      balanceBefore: before.toFixed(2),
      balanceAfter: after.toFixed(2),
      status: "completed",
      reference,
      metadata: { requestId: id, approvedBy: adminChatId, source: "telegram_admin" },
    });
    await tx.update(telegramUsers).set({
      ...(type === "deposit" ? { playWalletBalance: after.toFixed(2) } : { winWalletBalance: after.toFixed(2) }),
      updatedAt: new Date(),
    }).where(eq(telegramUsers.telegramId, request.telegramId));
    const updatedAt = new Date();
    if (type === "deposit") await tx.update(depositRequests).set({ status: "approved", updatedAt }).where(and(eq(depositRequests.id, id), eq(depositRequests.status, "pending")));
    else await tx.update(withdrawalRequests).set({ status: "approved", updatedAt }).where(and(eq(withdrawalRequests.id, id), eq(withdrawalRequests.status, "pending")));
    outcome = `Request #${id} approved.`;
    userNotification = { telegramId: request.telegramId, text: type === "deposit" ? `Your deposit request #${id} was approved. ${amount.toFixed(2)} ETB was added to your play wallet.` : `Your withdrawal request #${id} was approved. ${amount.toFixed(2)} ETB was deducted from your win wallet.` };
  });
  if (userNotification) await notifyWalletRequestUser(userNotification.telegramId, userNotification.text);
  await telegramRequest("sendMessage", { chat_id: adminChatId, text: outcome });
}

async function saveTelegramContact(message: NonNullable<TelegramUpdate["message"]>) {
  const contact = message.contact;
  const user = message.from;
  if (!contact || !user || contact.user_id !== user.id) {
    await telegramRequest("sendMessage", {
      chat_id: message.chat.id,
      text: "እባክዎ የራስዎን Telegram contact ብቻ ያጋሩ።",
    });
    return;
  }

  const registration = {
    telegramId: user.id,
    chatId: message.chat.id,
    firstName: contact.first_name || user.first_name,
    lastName: contact.last_name ?? user.last_name ?? null,
    username: user.username ?? null,
    phoneNumber: contact.phone_number,
    languageCode: user.language_code ?? null,
    updatedAt: new Date(),
  };
  const inserted = await db
    .insert(telegramUsers)
    .values({ ...registration, playWalletBalance: "10.00", winWalletBalance: "0.00" })
    .onConflictDoNothing({ target: telegramUsers.telegramId })
    .returning({ telegramId: telegramUsers.telegramId });

  if (inserted.length === 0) {
    await db
      .update(telegramUsers)
      .set(registration)
      .where(eq(telegramUsers.telegramId, user.id));
  }

  const text = inserted.length > 0
    ? `✅ እንኳን ደስ አለዎት ${registration.firstName}! ምዝገባዎ ተሳክቷል።\n\n🤑 የ10 ብር የPlay Wallet ገቢ ተደርጎልዎታል።\n\nአሁን Flash Bingoን መጫወት ይችላሉ።`
    : "እርስዎ ቀድሞውኑ የFlash Bingo ተጠቃሚ ነዎት።\n\nበቀጥታ ወደ ጨዋታ መቀላቀል ይችላሉ።";

  await telegramRequest("sendMessage", {
    chat_id: message.chat.id,
    text,
    reply_markup: getMainKeyboard(),
  });
}

async function handleTelegramUpdate(update: TelegramUpdate) {
  const callbackQuery = update.callback_query;
  if (callbackQuery) {
    const adminChatId = getAdminChatId();
    const callbackChatId = callbackQuery.message?.chat.id;
    const decision = callbackQuery.data?.match(/^(deposit|withdrawal):(approve|reject):(\d+)$/);
    if (decision && (!adminChatId || callbackChatId !== adminChatId)) {
      await telegramRequest("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Unauthorized.", show_alert: true });
      return;
    }
    await telegramRequest("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    if (callbackQuery.data === "deposit:telebirr" && callbackQuery.message) {
      await sendTelebirrAmountPrompt(callbackQuery.message.chat.id);
    } else if (decision && adminChatId) {
      await processAdminDecision(decision[1] as "deposit" | "withdrawal", decision[2] as "approve" | "reject", Number(decision[3]), adminChatId);
    }
    return;
  }

  const message = update.message;
  if (message?.contact) {
    await saveTelegramContact(message);
    return;
  }

  const text = message?.text?.trim();
  if (!message || !text) return;
  if (text === "/pending") {
    if (getAdminChatId() !== message.chat.id) {
      await telegramRequest("sendMessage", { chat_id: message.chat.id, text: "Unauthorized." });
      return;
    }
    await sendPendingRequests(message.chat.id);
    return;
  }
  if (text.startsWith("/start")) {
    await sendWelcomeMessage(message.chat.id, message.from?.first_name);
    return;
  }
  if (text === "🎮 Play Bingo" || text === "/play") {
    await sendMiniAppLink(message.chat.id);
    return;
  }
  if (text === "💰 Deposit" || text === "/deposit") {
    await sendDepositPaymentOptions(message.chat.id);
    return;
  }
  if (text === "💸 Withdraw" || text === "/withdraw") {
    await sendWithdrawalAmountPrompt(message.chat.id);
    return;
  }
  if (text === "📝 Register" || text === "/register") {
    await sendContactPrompt(message.chat.id);
    return;
  }
  if (text === "🔗 Invite & Earn" || text === "/invite") {
    await sendInviteMessage(message.chat.id);
    return;
  }
  if (text === "/menu") {
    await sendWelcomeMessage(message.chat.id, message.from?.first_name);
    return;
  }
  if (text === "🆘 Support" || text === "/help") {
    await telegramRequest("sendMessage", {
      chat_id: message.chat.id,
      text: "ለእርዳታ ቴሌግራም ላይ @******bingosupport ያነጋግሩን።",
      reply_markup: getMainKeyboard(),
    });
    return;
  }

  const withdrawalSession = withdrawalSessions.get(message.chat.id);
  if (withdrawalSession?.step === "amount") {
    const amount = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(amount) || amount < 100) {
      await telegramRequest("sendMessage", {
        chat_id: message.chat.id,
        text: "እባክዎን ከ100 ብር ጀምሮ የሆነ መጠን በቁጥር ብቻ ያስገቡ።",
      });
      return;
    }
    await sendWithdrawalPhonePrompt(message.chat.id, amount);
    return;
  }
  if (withdrawalSession?.step === "phone") {
    if (!/^09\d{8}$/.test(text)) {
      await telegramRequest("sendMessage", {
        chat_id: message.chat.id,
        text: "እባክዎን ትክክለኛ የTelebirr ቁጥር ያስገቡ። ምሳሌ: 0912345678",
      });
      return;
    }
    await sendWithdrawalOwnerNamePrompt(message.chat.id, withdrawalSession.amount, text);
    return;
  }
  if (withdrawalSession?.step === "owner-name") {
    if (text.length > 100) {
      await telegramRequest("sendMessage", {
        chat_id: message.chat.id,
        text: "እባክዎን ትክክለኛ የአካውንት ባለቤት ስም ያስገቡ።",
      });
      return;
    }
    await submitWithdrawalRequest(
      message.chat.id,
      message.from,
      withdrawalSession.amount,
      withdrawalSession.phone,
      text,
    );
    return;
  }

  const session = depositSessions.get(message.chat.id);
  if (session?.step === "amount") {
    const amount = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(amount) || amount < 10) {
      await telegramRequest("sendMessage", {
        chat_id: message.chat.id,
        text: "እባክዎ ከ10 ብር ጀምሮ የሆነ መጠን በቁጥር ብቻ ያስገቡ።",
      });
      return;
    }
    await sendTelebirrPaymentInstructions(message.chat.id, amount);
    return;
  }
  if (session?.step === "transaction-id") {
    if (text.length > 100) {
      await telegramRequest("sendMessage", {
        chat_id: message.chat.id,
        text: "እባክዎ ትክክለኛ የTransaction ID ያስገቡ።",
      });
      return;
    }
    await submitDepositRequest(message.chat.id, message.from, session.amount, text);
    return;
  }

  if (text === "👤 Profile & Account") {
    await sendProfileAccountMessage(message.chat.id, message.from?.id);
    return;
  }

  if (text === "🎁 Promo Code") {
    await telegramRequest("sendMessage", {
      chat_id: message.chat.id,
      text: "ይህ አማራጭ በቅርቡ ይገኛል።",
      reply_markup: getMainKeyboard(),
    });
  }
}

router.post("/telegram/webhook", async (req, res) => {
  if (!isTelegramWebhookRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    await handleTelegramUpdate(req.body as TelegramUpdate);
    res.sendStatus(200);
  } catch (error) {
    req.log?.error({ err: error }, "Telegram update handling failed");
    res.sendStatus(200);
  }
});

router.post("/telegram/auth", async (req, res) => {
  const botToken = getBotToken();
  const { initData } = req.body as TelegramAuthPayload;
  if (!botToken || typeof initData !== "string" || !isValidTelegramInitData(initData, botToken)) {
    res.status(401).json({ error: "Invalid Telegram authentication data" });
    return;
  }

  const user = parseTelegramUser(initData);
  if (!user) {
    res.status(401).json({ error: "Telegram user data is missing" });
    return;
  }
  const profile = await db.query.telegramUsers.findFirst({
    where: eq(telegramUsers.telegramId, user.id),
    columns: {
      firstName: true,
      lastName: true,
      playWalletBalance: true,
      winWalletBalance: true,
    },
  });
  res.json({ user, profile });
});

export async function registerTelegramWebhook() {
  const token = getBotToken();
  const webhookUrl = getWebhookUrl();
  const webAppUrl = getWebAppUrl();
  if (!token || !webhookUrl) {
    logger.warn(
      { hasBotToken: Boolean(token), hasWebhookUrl: Boolean(webhookUrl) },
      "Telegram webhook registration skipped because required configuration is incomplete",
    );
    return;
  }

  if (!webAppUrl) {
    logger.warn("Telegram Mini App URL is not configured; webhook will still be registered");
  }

  const secretToken = getWebhookSecret();
  await telegramRequest("setWebhook", {
    url: webhookUrl,
    ...(secretToken ? { secret_token: secretToken } : {}),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });

  const optionalSetup = [
    ...(webAppUrl
      ? [{
          method: "setChatMenuButton",
          body: {
            menu_button: { type: "web_app", text: "Flash Bingo", web_app: { url: webAppUrl } },
          },
        }]
      : []),
    {
      method: "setMyCommands",
      body: {
        commands: [
          { command: "start", description: "Flash Bingo ክፈት" },
          { command: "register", description: "Register" },
          { command: "play", description: "Play Bingo" },
          { command: "deposit", description: "Deposit" },
          { command: "withdraw", description: "Withdraw" },
          { command: "invite", description: "Invite & Earn" },
          { command: "help", description: "Support" },
        ],
      },
    },
  ] as const;

  for (const setup of optionalSetup) {
    try {
      await telegramRequest(setup.method, setup.body);
    } catch (error) {
      logger.warn({ err: error, method: setup.method }, "Optional Telegram bot setup failed");
    }
  }

  logger.info({ hasWebAppUrl: Boolean(webAppUrl) }, "Telegram webhook registered");
}

export default router;
