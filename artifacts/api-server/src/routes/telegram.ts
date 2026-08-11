import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, telegramUsers } from "@workspace/db";
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
    message?: { chat: { id: number } };
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

function isValidTelegramInitData(initData: string, botToken: string) {
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

function parseTelegramUser(initData: string) {
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

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: `👤 Profile & Account\n\n👤 ፕሮፋይል\n\nስም: ${name}\nስልክ: ${phone}\n\n💰 play wallet : 0 ETB\n🏆 win wallet : 0 ETB`,
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
  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    logger.error("TELEGRAM_ADMIN_CHAT_ID is not configured");
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: "የወጪ ጥያቄዎን ማስገባት አልተቻለም። እባክዎ ቆይተው እንደገና ይሞክሩ።",
    });
    return;
  }

  await telegramRequest("sendMessage", {
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
  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    logger.error("TELEGRAM_ADMIN_CHAT_ID is not configured");
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: "የሂሳብ መሙያ ጥያቄዎን ማስገባት አልተቻለም። እባክዎ ቆይተው እንደገና ይሞክሩ።",
    });
    return;
  }

  await telegramRequest("sendMessage", {
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
    .values(registration)
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
    await telegramRequest("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    if (callbackQuery.data === "deposit:telebirr" && callbackQuery.message) {
      await sendTelebirrAmountPrompt(callbackQuery.message.chat.id);
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

router.post("/telegram/auth", (req, res) => {
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
  res.json({ user });
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
