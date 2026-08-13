import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  appWalletTransactions,
  db,
  depositRequests,
  gameSettings,
  promoCodes,
  promoRedemptions,
  telegramReferrals,
  telegramUsers,
  walletTransactions,
  withdrawalRequests,
} from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import { getGameSettings, type EditableGameSettings } from "../lib/game-settings";
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

type TelegramPollingUpdate = TelegramUpdate & { update_id: number };

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
const promoSessions = new Set<number>();
const SUPPORT_USERNAME = "@******bingosupport";
const TELEBIRR_ACCOUNT_NUMBER = "0964846006";

function getBotToken() {
  const value = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  return value || undefined;
}

function getWebAppUrl() {
  const value = (process.env["TELEGRAM_WEB_APP_URL"] ?? process.env["RENDER_EXTERNAL_URL"])?.trim();
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
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function getAdminUserId() {
  const value = Number(process.env["TELEGRAM_ADMIN_USER_ID"]?.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : getAdminChatId();
}

function getAdminPanelUrl() {
  const webAppUrl = getWebAppUrl();
  return webAppUrl ? new URL("/admin", webAppUrl).toString() : undefined;
}

function getWebhookUrl() {
  const baseUrl = (process.env["TELEGRAM_WEBHOOK_URL"] ?? process.env["RENDER_EXTERNAL_URL"])?.trim();
  if (!baseUrl) return undefined;
  const normalizedBaseUrl = baseUrl.startsWith("http://") || baseUrl.startsWith("https://")
    ? baseUrl
    : `https://${baseUrl}`;
  return new URL("/api/telegram/webhook", normalizedBaseUrl).toString();
}

export async function telegramRequest<T>(method: string, body: Record<string, unknown>): Promise<T> {
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

async function telegramPhotoRequest<T>(photo: string, body: Record<string, unknown>): Promise<T> {
  const token = getBotToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const match = photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Invalid uploaded image");
  const form = new FormData();
  form.append("photo", new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), "broadcast-image");
  Object.entries(body).forEach(([key, value]) => form.append(key, typeof value === "string" ? value : JSON.stringify(value)));
  const response = await fetch(`${TELEGRAM_API_BASE}${token}/sendPhoto`, { method: "POST", body: form });
  const result = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram sendPhoto failed: ${result.description ?? response.statusText}`);
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

function getTelegramInitData(req: Request) {
  return req.header("x-telegram-init-data") ?? req.header("authorization")?.replace(/^tma\s+/i, "");
}

function getAuthenticatedTelegramUser(req: Request) {
  const initData = getTelegramInitData(req);
  const botToken = getBotToken();
  if (!initData || !botToken || !isValidTelegramInitData(initData, botToken)) return undefined;
  const user = parseTelegramUser(initData);
  return user && Number.isSafeInteger(user.id) && user.id > 0 ? user : undefined;
}

function getMainKeyboard(chatId?: number) {
  const keyboard: Array<Array<Record<string, unknown>>> = [
    [{ text: "📝 Register", request_contact: true }, { text: "🎮 Play Bingo" }],
    [{ text: "🎁 Promo Code" }, { text: "💰 Deposit" }],
    [{ text: "💸 Withdraw" }, { text: "🔗 Invite & Earn" }],
    [{ text: "👤 Profile & Account" }, { text: "🆘 Support" }],
  ];
  const adminPanelUrl = chatId === getAdminChatId() ? getAdminPanelUrl() : undefined;
  if (adminPanelUrl) keyboard.push([{ text: "🛠 Admin Panel", web_app: { url: adminPanelUrl } }]);
  return {
    keyboard,
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
    text: `🎉 እንኳን ወደ Venom Bingo በደህና መጡ${firstName ? ` ${firstName}` : ""}! 🎰\n\nለመመዝገብ "📝 Register" የሚለውን ይጫኑ።\n\nከታች ያለውን ምናሌ በመጠቀም ጨዋታውን ይጀምሩ።`,
    reply_markup: getMainKeyboard(chatId),
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
    reply_markup: getMainKeyboard(chatId),
  });
}

async function sendInviteMessage(chatId: number) {
  const [bot, settings] = await Promise.all([telegramRequest<{ username?: string }>("getMe", {}), getGameSettings()]);
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
    text: `🎉 ጋብዝ & አግኝ!\n\nጓደኞችዎን ይጋብዙ እና ለእያንዳንዱ ለጋበዙት አዲስ ተጠቃሚ ${settings.inviteBonus} ብር የPlay Wallet ቦነስ ያግኙ!\n\nየእርስዎ መጋበዣ ሊንክ፦\n${inviteLink.toString()}`,
    reply_markup: getMainKeyboard(chatId),
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
    reply_markup: getAdminApprovalKeyboard("withdrawal", request.id),
  });
  withdrawalSessions.delete(chatId);
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "እንኳን ደስ አልዎት የወጪ ጥያቄዎ ወደ አድሚን ተልኳል።\nየቴሌብር መልዕክት በቅርቡ ይደርስዎታል።",
    reply_markup: getMainKeyboard(chatId),
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
    text: `መሙላት የፈለጉት መጠን: ${amount} ETB\n\nእባክዎ ከታች ወዳለው የTelebirr አካውንት ብሩን ያስገቡ።\nአካውንት: ${TELEBIRR_ACCOUNT_NUMBER}\n\nከዚያም የትራንዛክሽን ቁጥሩን (Transaction ID) እዚህ ላይ ይፃፉልን። ጥያቄዎ በአጭር ጊዜ ውስጥ ይስተናገዳል።`,
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
    reply_markup: getAdminApprovalKeyboard("deposit", request.id),
  });
  depositSessions.delete(chatId);
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: `✅ የ${amount} ETB የሂሳብ መሙያ ጥያቄዎ ወደአድሚን ተልኳል። አድሚኑ ሲያጸድቀው መልዕክት ይደርስዎታል።`,
    reply_markup: getMainKeyboard(chatId),
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
    text: "Venom Bingo ለመክፈት ከታች ያለውን ቁልፍ ይጫኑ።",
    reply_markup: {
      inline_keyboard: [[{ text: "Venom Bingo ክፈት", web_app: { url: webAppUrl } }]],
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
    userNotification = { telegramId: request.telegramId, text: type === "deposit" ? `✅ የዲፖዚት ጥያቄዎ #${id} ተፈቅዷል።\n💰 ${amount.toFixed(2)} ETB ወደ Play Wallet ቀሪ ሂሳብዎ ተጨምሯል።` : `Your withdrawal request #${id} was approved. ${amount.toFixed(2)} ETB was deducted from your win wallet.` };
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
  const settings = await getGameSettings();
  let isNewRegistration = false;
  let rewardedInviterTelegramId: number | undefined;
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(telegramUsers)
      .values({ ...registration, playWalletBalance: settings.registrationBonus, winWalletBalance: "0.00" })
      .onConflictDoNothing({ target: telegramUsers.telegramId })
      .returning({ telegramId: telegramUsers.telegramId });
    isNewRegistration = Boolean(inserted);

    if (!inserted) {
      await tx
        .update(telegramUsers)
        .set(registration)
        .where(eq(telegramUsers.telegramId, user.id));
      return;
    }

    const [referral] = await tx.select().from(telegramReferrals)
      .where(eq(telegramReferrals.referredTelegramId, user.id))
      .for("update").limit(1);
    if (!referral || referral.inviterTelegramId === user.id) return;

    const [inviter] = await tx.select().from(telegramUsers)
      .where(eq(telegramUsers.telegramId, referral.inviterTelegramId))
      .for("update").limit(1);
    if (!inviter) return;

    const reference = `referral:signup:${user.id}`;
    const balanceBefore = Number(inviter.playWalletBalance);
    const balanceAfter = (balanceBefore + Number(settings.inviteBonus)).toFixed(2);
    const [ledger] = await tx.insert(walletTransactions).values({
      telegramId: inviter.telegramId,
      type: "adjustment",
      amount: settings.inviteBonus,
      balanceBefore: balanceBefore.toFixed(2),
      balanceAfter,
      status: "completed",
      reference,
      metadata: {
        source: "telegram_referral",
        inviterTelegramId: inviter.telegramId,
        referredTelegramId: user.id,
      },
    }).onConflictDoNothing({ target: walletTransactions.reference }).returning({ id: walletTransactions.id });
    if (!ledger) return;

    await tx.update(telegramUsers).set({ playWalletBalance: balanceAfter, updatedAt: new Date() })
      .where(eq(telegramUsers.telegramId, inviter.telegramId));
    rewardedInviterTelegramId = inviter.telegramId;
  });

  if (rewardedInviterTelegramId) {
    try {
      await notifyWalletRequestUser(
        rewardedInviterTelegramId,
        `🎉 አዲስ ተጠቃሚ በእርስዎ ኢንቫይት ሊንክ ገብቷል።\n💰 ${settings.inviteBonus} ብር ወደ Play Wallet ተጨምሯል።`,
      );
    } catch (error) {
      logger.error({ err: error, inviterTelegramId: rewardedInviterTelegramId }, "Referral reward notification failed");
    }
  }

  const text = isNewRegistration
    ? `✅ እንኳን ደስ አለዎት ${registration.firstName}! ምዝገባዎ ተሳክቷል።\n\n🤑 የ${settings.registrationBonus} ብር የPlay Wallet ገቢ ተደርጎልዎታል።\n\nአሁን Venom Bingoን መጫወት ይችላሉ።`
    : "እርስዎ ቀድሞውኑ የVenom Bingo ተጠቃሚ ነዎት።\n\nበቀጥታ ወደ ጨዋታ መቀላቀል ይችላሉ።";

  await telegramRequest("sendMessage", {
    chat_id: message.chat.id,
    text,
    reply_markup: getMainKeyboard(message.chat.id),
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
  const startMatch = text.match(/^\/start(?:\s+re([0-9]+))?$/);
  if (startMatch) {
    const inviterChatId = startMatch[1] ? Number(startMatch[1]) : undefined;
    const referredTelegramId = message.from?.id;
    if (inviterChatId && Number.isSafeInteger(inviterChatId) && referredTelegramId) {
      const inviter = await db.query.telegramUsers.findFirst({
        where: eq(telegramUsers.chatId, inviterChatId),
        columns: { telegramId: true },
      });
      if (inviter && inviter.telegramId !== referredTelegramId) {
        await db.insert(telegramReferrals).values({
          referredTelegramId,
          inviterTelegramId: inviter.telegramId,
        }).onConflictDoNothing({ target: telegramReferrals.referredTelegramId });
      }
    }
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
      text: `ለእርዳታ ቴሌግራም ላይ ${SUPPORT_USERNAME} ያነጋግሩን።`,
      reply_markup: getMainKeyboard(message.chat.id),
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

  if (text === "🎁 Promo Code" || text === "/promo") {
    promoSessions.add(message.chat.id);
    await telegramRequest("sendMessage", {
      chat_id: message.chat.id,
      text: "እባክዎ Promo Code ያስገቡ።",
      reply_markup: { force_reply: true },
    });
    return;
  }

  if (promoSessions.has(message.chat.id)) {
    promoSessions.delete(message.chat.id);
    const result = await redeemPromoCode(message.from?.id ?? 0, text);
    await telegramRequest("sendMessage", {
      chat_id: message.chat.id,
      text: result.ok ? `🎉 እንኳን ደስ አለዎት! ${result.amount} ብር ወደ Play Wallet ተጨምሯል።` : promoFailureMessage(result.reason),
      reply_markup: getMainKeyboard(message.chat.id),
    });
    return;
  }
}

router.post("/telegram/webhook", async (req, res) => {
  if (!isTelegramWebhookRequest(req)) {
    logger.warn({ hasSecretHeader: Boolean(req.header("x-telegram-bot-api-secret-token")), hasConfiguredSecret: Boolean(getWebhookSecret()) }, "Telegram webhook rejected: secret mismatch");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  logger.info({ updateKeys: Object.keys(req.body ?? {}) }, "Telegram webhook update received");
  try {
    await handleTelegramUpdate(req.body as TelegramUpdate);
    res.sendStatus(200);
  } catch (error) {
    req.log?.error({ err: error }, "Telegram update handling failed");
    res.sendStatus(200);
  }
});

router.post("/telegram/wallet-flow", async (req, res) => {
  const user = getAuthenticatedTelegramUser(req);
  if (!user) {
    res.status(401).json({ error: "Valid Telegram authentication is required" });
    return;
  }
  const action = (req.body as { action?: unknown }).action;
  if (action !== "deposit" && action !== "withdrawal") {
    res.status(400).json({ error: "Invalid wallet action" });
    return;
  }
  const profile = await db.query.telegramUsers.findFirst({
    where: eq(telegramUsers.telegramId, user.id),
    columns: { chatId: true },
  });
  if (!profile) {
    res.status(404).json({ error: "Telegram user is not registered" });
    return;
  }
  if (action === "deposit") await sendDepositPaymentOptions(profile.chatId);
  else await sendWithdrawalAmountPrompt(profile.chatId);
  res.json({ success: true });
});

router.post("/telegram/auth", async (req, res) => {
  const botToken = getBotToken();
  const { initData } = req.body as TelegramAuthPayload;
  if (!botToken) {
    logger.warn({ hasInitData: typeof initData === "string" && initData.length > 0 }, "Mini App auth rejected: TELEGRAM_BOT_TOKEN is missing");
    res.status(401).json({ error: "Invalid Telegram authentication data" });
    return;
  }
  if (typeof initData !== "string" || initData.length === 0) {
    logger.warn("Mini App auth rejected: Telegram initData is missing");
    res.status(401).json({ error: "Invalid Telegram authentication data" });
    return;
  }
  if (!isValidTelegramInitData(initData, botToken)) {
    logger.warn("Mini App auth rejected: Telegram initData is invalid or expired");
    res.status(401).json({ error: "Invalid Telegram authentication data" });
    return;
  }

  const user = parseTelegramUser(initData);
  if (!user) {
    logger.warn("Mini App auth rejected: Telegram user data is missing");
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
  logger.info({ telegramId: user.id, profileFound: Boolean(profile), hasPlayWalletBalance: Boolean(profile?.playWalletBalance), hasWinWalletBalance: Boolean(profile?.winWalletBalance) }, "Mini App wallet profile lookup completed");
  res.json({ user, profile, isAdmin: user.id === getAdminUserId() });
});

type PromoRedeemResult =
  | { ok: true; amount: string }
  | { ok: false; reason: "invalid" | "inactive" | "expired" | "limit" | "already" | "unregistered" };

function normalizePromoCode(value: string) {
  return value.trim().toUpperCase();
}

async function redeemPromoCode(telegramId: number, code: string): Promise<PromoRedeemResult> {
  const normalizedCode = normalizePromoCode(code);
  if (!normalizedCode) return { ok: false, reason: "invalid" };
  return db.transaction(async (tx) => {
    const [promo] = await tx.select().from(promoCodes).where(eq(promoCodes.code, normalizedCode)).for("update").limit(1);
    if (!promo) return { ok: false, reason: "invalid" };
    if (!promo.isActive) return { ok: false, reason: "inactive" };
    if (promo.expiresAt && promo.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
    if (promo.maxRedemptions !== null && promo.redemptionCount >= promo.maxRedemptions) return { ok: false, reason: "limit" };
    const [user] = await tx.select().from(telegramUsers).where(eq(telegramUsers.telegramId, telegramId)).for("update").limit(1);
    if (!user) return { ok: false, reason: "unregistered" };
    const [existing] = await tx.select({ id: promoRedemptions.id }).from(promoRedemptions)
      .where(and(eq(promoRedemptions.promoCodeId, promo.id), eq(promoRedemptions.telegramId, telegramId))).limit(1);
    if (existing) return { ok: false, reason: "already" };
    const before = Number(user.playWalletBalance);
    const amount = Number(promo.rewardAmount).toFixed(2);
    const after = (before + Number(amount)).toFixed(2);
    const [redemption] = await tx.insert(promoRedemptions).values({ promoCodeId: promo.id, telegramId, rewardAmount: amount }).returning({ id: promoRedemptions.id });
    const reference = `promo:${promo.id}:user:${telegramId}`;
    await tx.insert(walletTransactions).values({
      telegramId,
      type: "adjustment",
      amount,
      balanceBefore: before.toFixed(2),
      balanceAfter: after,
      status: "completed",
      reference,
      metadata: { source: "promo_code", promoCodeId: promo.id, redemptionId: redemption.id },
    });
    await tx.update(telegramUsers).set({ playWalletBalance: after, updatedAt: new Date() }).where(eq(telegramUsers.telegramId, telegramId));
    await tx.update(promoCodes).set({ redemptionCount: promo.redemptionCount + 1, updatedAt: new Date() }).where(eq(promoCodes.id, promo.id));
    return { ok: true, amount };
  });
}

function promoFailureMessage(reason: Exclude<PromoRedeemResult, { ok: true }>["reason"]) {
  return {
    invalid: "የPromo Code ኮዱ ትክክል አይደለም።",
    inactive: "ይህ Promo Code አሁን አክቲቭ አይደለም።",
    expired: "ይህ Promo Code ጊዜው አልፎበታል።",
    limit: "የዚህ Promo Code አጠቃቀም ቁጥር ሙሉ ሆኗል።",
    already: "ይህን Promo Code ቀደም ብለው ተጠቅመዋል።",
    unregistered: "እባክዎ መጀመሪያ ይመዝገቡ።",
  }[reason];
}

function requireAdmin(req: Request, res: Response) {
  const user = getAuthenticatedTelegramUser(req);
  if (!user) {
    res.status(401).json({ error: "Valid Telegram authentication is required" });
    return undefined;
  }
  const adminUserId = getAdminUserId();
  if (!adminUserId || user.id !== adminUserId) {
    res.status(403).json({ error: "Admin access is required" });
    return undefined;
  }
  return { user, adminChatId: getAdminChatId() ?? adminUserId };
}

function parseEditableGameSettings(value: unknown): EditableGameSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const settings = value as Record<string, unknown>;
  const percentageFields = ["mainPrizePercentage", "leaderboardPoolPercentage", "leaderboardFirstPercentage", "leaderboardSecondPercentage", "leaderboardThirdPercentage"] as const;
  const bonusFields = ["registrationBonus", "inviteBonus"] as const;
  const pointFields = ["leaderboardCardPurchasePoints", "leaderboardCardReleasePoints", "leaderboardWinPoints"] as const;
  const parsedPercentages = Object.fromEntries(percentageFields.map((field) => [field, Number(settings[field])])) as Record<typeof percentageFields[number], number>;
  const parsedBonuses = Object.fromEntries(bonusFields.map((field) => [field, Number(settings[field])])) as Record<typeof bonusFields[number], number>;
  const parsedPoints = Object.fromEntries(pointFields.map((field) => [field, Number(settings[field])])) as Record<typeof pointFields[number], number>;
  const maxCardsPerPlayer = Number(settings.maxCardsPerPlayer);
  if (percentageFields.some((field) => !Number.isFinite(parsedPercentages[field]) || parsedPercentages[field] < 0 || parsedPercentages[field] > 100)) return undefined;
  if (bonusFields.some((field) => !Number.isFinite(parsedBonuses[field]) || parsedBonuses[field] < 0 || parsedBonuses[field] > 100_000)) return undefined;
  if (pointFields.some((field) => !Number.isInteger(parsedPoints[field]) || parsedPoints[field] < -100 || parsedPoints[field] > 100)) return undefined;
  if (!Number.isInteger(maxCardsPerPlayer) || maxCardsPerPlayer < 1 || maxCardsPerPlayer > 500) return undefined;
  if (parsedPercentages.mainPrizePercentage + parsedPercentages.leaderboardPoolPercentage > 100 || Math.abs(parsedPercentages.leaderboardFirstPercentage + parsedPercentages.leaderboardSecondPercentage + parsedPercentages.leaderboardThirdPercentage - 100) > 0.001) return undefined;
  return {
    registrationBonus: parsedBonuses.registrationBonus.toFixed(2),
    inviteBonus: parsedBonuses.inviteBonus.toFixed(2),
    ...Object.fromEntries(percentageFields.map((field) => [field, parsedPercentages[field].toFixed(2)])),
    maxCardsPerPlayer: String(maxCardsPerPlayer),
    ...Object.fromEntries(pointFields.map((field) => [field, parsedPoints[field].toFixed(2)])),
  } as EditableGameSettings;
}

router.post("/telegram/promo/redeem", async (req, res) => {
  const user = getAuthenticatedTelegramUser(req);
  if (!user) {
    res.status(401).json({ error: "Valid Telegram authentication is required" });
    return;
  }
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const result = await redeemPromoCode(user.id, code);
  if (!result.ok) {
    res.status(400).json({ error: promoFailureMessage(result.reason) });
    return;
  }
  res.json({ success: true, amount: result.amount });
});

router.get("/telegram/admin/promos", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt)));
});

router.post("/telegram/admin/promos", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = req.body as { code?: unknown; rewardAmount?: unknown; maxRedemptions?: unknown; expiresAt?: unknown };
  const code = typeof body.code === "string" ? normalizePromoCode(body.code) : "";
  const rewardAmount = typeof body.rewardAmount === "string" || typeof body.rewardAmount === "number" ? Number(body.rewardAmount) : NaN;
  const maxRedemptions = body.maxRedemptions === "" || body.maxRedemptions === null || body.maxRedemptions === undefined ? null : Number(body.maxRedemptions);
  const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null;
  if (!/^[A-Z0-9_-]{3,64}$/.test(code) || !Number.isFinite(rewardAmount) || rewardAmount <= 0 || rewardAmount > 100_000 || (maxRedemptions !== null && (!Number.isSafeInteger(maxRedemptions) || maxRedemptions < 1)) || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
    res.status(400).json({ error: "Enter a valid code, reward amount, redemption limit, and expiration date." });
    return;
  }
  try {
    const [promo] = await db.insert(promoCodes).values({ code, rewardAmount: rewardAmount.toFixed(2), maxRedemptions, expiresAt, createdByTelegramId: admin.user.id, isActive: false }).returning();
    res.status(201).json(promo);
  } catch (error) {
    if (error instanceof Error && /promo_codes_code_idx|duplicate key/i.test(error.message)) {
      res.status(409).json({ error: "ይህ Promo Code አስቀድሞ አለ።" });
      return;
    }
    throw error;
  }
});

router.post("/telegram/admin/promos/:id/:action", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  const action = req.params.action;
  if (!Number.isSafeInteger(id) || id <= 0 || (action !== "activate" && action !== "deactivate")) {
    res.status(400).json({ error: "Invalid promo action" });
    return;
  }
  const [promo] = await db.update(promoCodes).set({ isActive: action === "activate", updatedAt: new Date() }).where(eq(promoCodes.id, id)).returning();
  if (!promo) {
    res.status(404).json({ error: "Promo Code not found" });
    return;
  }
  res.json(promo);
});

router.get("/telegram/admin/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const users = await db.select({
    telegramId: telegramUsers.telegramId,
    chatId: telegramUsers.chatId,
    firstName: telegramUsers.firstName,
    lastName: telegramUsers.lastName,
    username: telegramUsers.username,
    phoneNumber: telegramUsers.phoneNumber,
    languageCode: telegramUsers.languageCode,
    playWalletBalance: telegramUsers.playWalletBalance,
    winWalletBalance: telegramUsers.winWalletBalance,
    createdAt: telegramUsers.createdAt,
    updatedAt: telegramUsers.updatedAt,
  }).from(telegramUsers).orderBy(desc(telegramUsers.createdAt));
  res.json(users);
});

router.post("/telegram/admin/broadcast", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = req.body as { photo?: unknown; caption?: unknown };
  const photo = typeof body.photo === "string" ? body.photo.trim() : "";
  const caption = typeof body.caption === "string" ? body.caption.trim() : "";
  const webAppUrl = getWebAppUrl();
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 7_000_000 || !caption || caption.length > 1_024 || !webAppUrl) {
    res.status(400).json({ error: "Upload a JPEG, PNG, or WebP image up to 5 MB, enter message text, and configure the web app URL." });
    return;
  }

  const recipients = await db.select({ chatId: telegramUsers.chatId }).from(telegramUsers);
  const chatIds = [...new Set(recipients.map(({ chatId }) => chatId))];
  let sent = 0;
  let failed = 0;
  for (const chatId of chatIds) {
    try {
      await telegramPhotoRequest(photo, {
        chat_id: String(chatId),
        caption,
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: "Play Now", web_app: { url: webAppUrl } }]],
        }),
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ err: error, chatId }, "Telegram broadcast delivery failed");
    }
  }
  res.json({ targeted: chatIds.length, sent, failed });
});

router.get("/telegram/admin/settings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(await getGameSettings());
});

router.put("/telegram/admin/settings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const settings = parseEditableGameSettings(req.body);
  if (!settings) {
    res.status(400).json({ error: "Enter valid bonuses and percentages. Leaderboard prizes must total 100%, and main plus leaderboard pool cannot exceed 100%." });
    return;
  }
  const [updated] = await db.insert(gameSettings).values({ id: 1, ...settings, updatedAt: new Date() })
    .onConflictDoUpdate({ target: gameSettings.id, set: { ...settings, updatedAt: new Date() } }).returning();
  res.json(updated);
});

router.get("/telegram/admin/requests", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const [deposits, withdrawals, appWallet] = await Promise.all([
    db.query.depositRequests.findMany({
      where: eq(depositRequests.status, "pending"),
      orderBy: [desc(depositRequests.createdAt)],
    }),
    db.query.withdrawalRequests.findMany({
      where: eq(withdrawalRequests.status, "pending"),
      orderBy: [desc(withdrawalRequests.createdAt)],
    }),
    db.select({ balance: sql<string>`coalesce(sum(${appWalletTransactions.amount}), 0)` }).from(appWalletTransactions),
  ]);
  res.json({ deposits, withdrawals, appWalletBalance: appWallet[0]?.balance ?? "0.00" });
});

router.post("/telegram/admin/requests/:type/:id/:action", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const type = req.params.type;
  const action = req.params.action;
  const id = Number(req.params.id);
  if ((type !== "deposit" && type !== "withdrawal") || (action !== "approve" && action !== "reject") || !Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid admin request action" });
    return;
  }
  await processAdminDecision(type, action, id, admin.adminChatId);
  res.json({ success: true });
});

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function startTelegramPolling() {
  const globalState = globalThis as typeof globalThis & { __telegramPolling?: boolean };
  if (globalState.__telegramPolling) return;
  globalState.__telegramPolling = true;
  void (async () => {
    const token = getBotToken();
    if (!token) {
      logger.warn("Telegram polling skipped because TELEGRAM_BOT_TOKEN is missing");
      return;
    }

    try {
      await telegramRequest("deleteWebhook", { drop_pending_updates: false });
      const bot = await telegramRequest<{ username?: string }>("getMe", {});
      logger.info({ botUsername: bot.username ?? "unknown" }, "Telegram webhook deleted; long polling started");
    } catch (error) {
      logger.error({ err: error }, "Telegram polling could not initialize");
    }

    let offset = 0;
    while (true) {
      try {
        const updates = await telegramRequest<TelegramPollingUpdate[]>("getUpdates", {
          offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        });
        logger.info({ updateCount: updates.length, offset }, "Telegram polling response received");
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleTelegramUpdate(update);
          } catch (error) {
            logger.error({ err: error, updateId: update.update_id }, "Telegram polling update handling failed");
          }
        }
      } catch (error) {
        logger.error({ err: error }, "Telegram polling request failed");
        await sleep(5000);
      }
    }
  })();
}

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
  logger.info({ webhookUrl, hasSecretToken: Boolean(secretToken), hasWebAppUrl: Boolean(webAppUrl) }, "Registering Telegram webhook");
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
            menu_button: { type: "web_app", text: "Venom Bingo", web_app: { url: webAppUrl } },
          },
        }]
      : []),
    {
      method: "setMyCommands",
      body: {
        commands: [
          { command: "start", description: "Venom Bingo ክፈት" },
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
