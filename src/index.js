import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import {
  buildMicrosoftAuthUrl,
  exchangeCodeForToken,
  refreshToken,
  getMe,
  getUnreadMessages,
  getReadOlderThan,
  markMessageSummarized,
  moveToDeletedItems,
  permanentDelete
} from "./graph.js";
import {
  isImapConfigured,
  getImapAccountInfo,
  testImapConnection,
  getUnreadImapMessagesForSummary,
  cleanupImapMessages
} from "./imapMail.js";
import { summarizeMessages, getAiConfig } from "./ai.js";
import { sendSummaryPush } from "./push.js";
import { loadStore, saveStore, updateStore, nowIso, isDue } from "./store.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const DELETE_AFTER_DAYS = Number(process.env.DELETE_AFTER_DAYS || 30);
const PERMANENT_DELETE_AFTER_DAYS = Number(process.env.PERMANENT_DELETE_AFTER_DAYS || 7);
const AUTO_DELETE_ENABLED = String(process.env.AUTO_DELETE_ENABLED ?? "true").toLowerCase() === "true";
const MAIL_PROVIDER = String(process.env.MAIL_PROVIDER || "graph").toLowerCase();
const USE_IMAP = MAIL_PROVIDER === "qq" || MAIL_PROVIDER === "imap";
const SUMMARY_TIMEZONE = process.env.SUMMARY_TIMEZONE || "Asia/Shanghai";

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function trimPushBody(text) {
  return text.replace(/[#*`>\-]/g, "").replace(/\s+/g, " ").slice(0, 160);
}

function stripAiSettings(settings = {}) {
  const { aiModel, aiBaseUrl, aiApiKey, aiApi, ...safeSettings } = settings || {};
  return safeSettings;
}

function positiveInt(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function getSummaryMode(body = {}) {
  return body?.mode === "scheduled" ? "scheduled" : "test";
}

function sendSummaryJson(res, payload, status = 200) {
  return res.status(status).type("application/json").json(payload);
}

function sendSummaryError(res, body, error, status = 200) {
  return sendSummaryJson(res, {
    ok: false,
    mode: getSummaryMode(body),
    processed: 0,
    error: error?.message || String(error || "Request failed")
  }, status);
}

function formatSummaryTime(date) {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SUMMARY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(safeDate);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const hour = map.hour === "24" ? "00" : map.hour;
  return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}`;
}

function messageDate(message) {
  const date = new Date(message?.receivedDateTime || 0);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function getMessageText(message) {
  return `${message?.subject || ""} ${message?.from?.emailAddress?.name || ""} ${message?.from?.emailAddress?.address || ""} ${message?.bodyPreview || ""}`.toLowerCase();
}

function isSpamLike(message) {
  if (message?.sourceFolder === "junkemail") return true;
  const text = getMessageText(message);
  return [
    "unsubscribe", "newsletter", "promotion", "promo", "sale", "discount", "coupon",
    "广告", "促销", "优惠", "折扣", "订阅", "营销", "推广", "newsletter", "digest"
  ].some(keyword => text.includes(keyword));
}

function isImportantLike(message) {
  if (isSpamLike(message)) return false;
  const text = getMessageText(message);
  return [
    "urgent", "action required", "deadline", "due", "invoice", "payment", "security", "login", "verify",
    "重要", "紧急", "截止", "到期", "账单", "发票", "付款", "支付", "确认", "回复", "登录", "安全", "账号", "验证码", "异常", "逾期"
  ].some(keyword => text.includes(keyword));
}

function getMessageStats(messages) {
  const spamCount = messages.filter(isSpamLike).length;
  const importantCount = messages.filter(isImportantLike).length;
  return { importantCount, spamCount };
}

function getSummaryTimeRange(messages, options) {
  const now = new Date();
  let startDate = now;
  let endDate = now;

  if (options.mode === "scheduled") {
    const hours = positiveInt(options.windowHours, 24, 24 * 60);
    startDate = new Date(now.getTime() - hours * 60 * 60 * 1000);
    endDate = now;
  } else if (messages.length > 0) {
    const dates = messages.map(messageDate).sort((a, b) => a - b);
    startDate = dates[0];
    endDate = dates[dates.length - 1];
  }

  return {
    startDate,
    endDate,
    startTime: formatSummaryTime(startDate),
    endTime: formatSummaryTime(endDate)
  };
}

function buildSummaryMeta(messages, options) {
  return {
    ...getSummaryTimeRange(messages, options),
    ...getMessageStats(messages),
    processedCount: messages.length
  };
}

function getScheduledOptionsForUser(user) {
  const frequency = user?.settings?.frequency || "daily";
  if (frequency === "sixHours") {
    return { mode: "scheduled", windowHours: 6, maxMessages: 30 };
  }
  if (frequency === "monthly") {
    return { mode: "scheduled", windowHours: 720, maxMessages: 50 };
  }
  return { mode: "scheduled", windowHours: 24, maxMessages: 30 };
}

function normalizeSummaryOptions(body = {}, user = null) {
  const mode = getSummaryMode(body);

  if (mode === "test") {
    return {
      mode: "test",
      latestCount: positiveInt(body.latestCount ?? body.limit, 3, 5)
    };
  }

  const defaults = getScheduledOptionsForUser(user);
  return {
    mode: "scheduled",
    windowHours: positiveInt(body.windowHours, defaults.windowHours, 24 * 60),
    maxMessages: positiveInt(body.maxMessages, 30, 100)
  };
}

function filterMessagesByWindow(messages, options, store = null) {
  const mode = options.mode === "test" ? "test" : "scheduled";
  const limit = mode === "test" ? positiveInt(options.latestCount ?? options.limit, 3, 5) : positiveInt(options.maxMessages, 30, 100);
  const cutoff = mode === "scheduled"
    ? Date.now() - positiveInt(options.windowHours, 24, 24 * 60) * 60 * 60 * 1000
    : null;

  const filtered = messages
    .filter(message => {
      if (mode === "scheduled" && store?.summarizedMessages?.[message.id]) return false;
      if (!cutoff) return true;
      const receivedAt = new Date(message.receivedDateTime || 0).getTime();
      return Number.isFinite(receivedAt) && receivedAt >= cutoff;
    })
    .sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));

  return {
    messages: filtered.slice(0, limit),
    hasMore: filtered.length > limit
  };
}

function ensureImapDefaultUser(store, deviceId = "") {
  if (!USE_IMAP || !isImapConfigured()) return null;

  const info = getImapAccountInfo();
  const userId = "imap_default_user";
  const existingDevice = Object.values(store.devices || {}).find(device => device.userId === userId) || null;
  const resolvedDeviceId = deviceId || existingDevice?.deviceId || "imap_default_device";

  const device = {
    ...(existingDevice || {}),
    ...(store.devices?.[resolvedDeviceId] || {}),
    deviceId: resolvedDeviceId,
    userId,
    platform: store.devices?.[resolvedDeviceId]?.platform || existingDevice?.platform || "Render",
    deviceToken: store.devices?.[resolvedDeviceId]?.deviceToken || existingDevice?.deviceToken || "",
    updatedAt: nowIso()
  };

  const currentUser = store.users[userId] || {};
  const user = {
    ...currentUser,
    id: userId,
    deviceId: resolvedDeviceId,
    provider: info.provider,
    imap: {
      email: info.email,
      host: info.host,
      inboxMailbox: info.inboxMailbox,
      junkMailbox: info.junkMailbox
    },
    settings: {
      enabled: true,
      frequency: "daily",
      language: "zh-CN",
      includeJunkUnread: Boolean(info.junkMailbox),
      autoDeleteEnabled: true,
      deleteAfterDays: DELETE_AFTER_DAYS,
      permanentDeleteAfterDays: PERMANENT_DELETE_AFTER_DAYS,
      ...stripAiSettings(currentUser.settings || {})
    },
    updatedAt: nowIso()
  };

  store.devices[resolvedDeviceId] = device;
  store.users[userId] = user;

  return { device, user };
}

function resolveSummaryTarget(store, deviceId = "") {
  const device = store.devices?.[deviceId];
  if (device?.userId && store.users?.[device.userId]) {
    return { device, user: store.users[device.userId] };
  }

  return ensureImapDefaultUser(store, deviceId);
}

async function getFreshAccessToken(user, store) {
  const expiresAt = user.tokens?.expiresAt ? new Date(user.tokens.expiresAt) : new Date(0);
  if (Date.now() < expiresAt.getTime() - 5 * 60 * 1000) return user.tokens.accessToken;

  const refreshed = await refreshToken(user.tokens.refreshToken);
  user.tokens.accessToken = refreshed.access_token;
  user.tokens.refreshToken = refreshed.refresh_token || user.tokens.refreshToken;
  user.tokens.expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  store.users[user.id] = user;
  return user.tokens.accessToken;
}

app.get("/health", (_, res) => {
  res.json({ ok: true, time: nowIso(), provider: USE_IMAP ? "imap" : "graph" });
});

app.get("/imap/test", async (_, res) => {
  try {
    if (!USE_IMAP) return res.json({ ok: false, error: "MAIL_PROVIDER is not qq/imap" });
    const result = await testImapConnection();
    res.json(result);
  } catch (err) {
    console.error("IMAP test failed", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/ai/test", async (_, res) => {
  const { apiKey, baseUrl, model } = getAiConfig({});

  if (!apiKey) {
    return res.json({
      ok: false,
      model,
      error: "Missing AI API key"
    });
  }

  try {
    const aiRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是一个健康检查助手。" },
          { role: "user", content: "请只回复 OK" }
        ],
        temperature: 0
      })
    });

    const responseText = await aiRes.text();

    if (!aiRes.ok) {
      return res.json({
        ok: false,
        model,
        error: `AI test failed: ${aiRes.status} ${responseText}`
      });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      return res.json({
        ok: false,
        model,
        error: `AI test returned non-JSON response: ${responseText.slice(0, 300)}`
      });
    }

    res.json({
      ok: true,
      model,
      message: "AI 模型连接正常",
      reply: data.choices?.[0]?.message?.content?.trim() || ""
    });
  } catch (err) {
    console.error("AI test failed", err);
    res.json({
      ok: false,
      model,
      error: err.message
    });
  }
});

app.post("/devices/register", (req, res) => {
  const { deviceId = makeId("device"), deviceToken = "", platform = "iOS" } = req.body || {};
  const result = updateStore(store => {
    const baseDevice = {
      ...(store.devices[deviceId] || {}),
      deviceId,
      deviceToken,
      platform,
      updatedAt: nowIso()
    };

    if (USE_IMAP && isImapConfigured()) {
      const resolved = ensureImapDefaultUser(store, deviceId);
      if (resolved) {
        baseDevice.userId = resolved.user.id;
        store.devices[deviceId] = {
          ...resolved.device,
          ...baseDevice,
          userId: resolved.user.id
        };
        return store.devices[deviceId];
      }
    }

    store.devices[deviceId] = baseDevice;
    return store.devices[deviceId];
  });
  res.json(result);
});

app.get("/auth/start", (req, res) => {
  const deviceId = String(req.query.deviceId || "");
  if (!deviceId) return res.status(400).send("Missing deviceId");

  if (USE_IMAP) {
    return res.send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font-family:-apple-system;padding:28px;background:#101827;color:white"><h2>QQ 邮箱模式</h2><p>此版本不需要 Microsoft 登录。请在 Render 环境变量里配置 IMAP_USER 和 IMAP_PASS，然后回到 App 点击刷新状态。</p></body>`);
  }

  const state = crypto.randomBytes(16).toString("hex");
  updateStore(store => {
    store.authStates[state] = { deviceId, createdAt: nowIso() };
  });
  res.redirect(buildMicrosoftAuthUrl({ deviceId, state }));
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state: rawState } = req.query;
    const [deviceId, state] = String(rawState || "").split(":");
    if (!code || !deviceId || !state) return res.status(400).send("Invalid callback");

    const tokens = await exchangeCodeForToken(String(code));
    const me = await getMe(tokens.access_token);
    const userId = me.id || makeId("user");

    updateStore(store => {
      const authState = store.authStates[state];
      if (!authState || authState.deviceId !== deviceId) throw new Error("Auth state mismatch");
      delete store.authStates[state];

      store.devices[deviceId] = {
        ...(store.devices[deviceId] || {}),
        deviceId,
        userId,
        updatedAt: nowIso()
      };
      store.users[userId] = {
        ...(store.users[userId] || {}),
        id: userId,
        deviceId,
        microsoft: me,
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        },
        settings: {
          enabled: true,
          frequency: "daily",
          language: "zh-CN",
          includeJunkUnread: true,
          autoDeleteEnabled: true,
          deleteAfterDays: DELETE_AFTER_DAYS,
          permanentDeleteAfterDays: PERMANENT_DELETE_AFTER_DAYS
        },
        updatedAt: nowIso()
      };
    });

    res.send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font-family:-apple-system;padding:28px;background:#101827;color:white"><h2>登录完成</h2><p>Outlook 已授权，可以回到 App。</p></body>`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Login failed: ${err.message}`);
  }
});

app.get("/auth/status", (req, res) => {
  const deviceId = String(req.query.deviceId || "");
  const store = loadStore();
  const target = resolveSummaryTarget(store, deviceId);
  const user = target?.user || null;
  res.json({
    linked: Boolean(user),
    user: user ? {
      displayName: user.microsoft?.displayName || (user.provider === "qq" ? "QQ 邮箱" : user.imap?.email),
      email: user.microsoft?.mail || user.microsoft?.userPrincipalName || user.imap?.email,
      settings: stripAiSettings(user.settings),
      lastRunAt: user.lastRunAt
    } : null
  });
});

app.post("/settings", (req, res) => {
  const { deviceId, settings = {} } = req.body || {};
  const result = updateStore(store => {
    const target = resolveSummaryTarget(store, deviceId);
    if (!target?.user) throw new Error("Device not linked");
    const current = stripAiSettings(target.user.settings || {});
    const safeSettings = stripAiSettings(settings);
    store.users[target.user.id].settings = {
      ...current,
      ...safeSettings,
      language: "zh-CN",
      includeJunkUnread: true,
      autoDeleteEnabled: safeSettings.autoDeleteEnabled ?? current.autoDeleteEnabled ?? true,
      deleteAfterDays: Number(safeSettings.deleteAfterDays || current.deleteAfterDays || DELETE_AFTER_DAYS),
      permanentDeleteAfterDays: Number(safeSettings.permanentDeleteAfterDays || current.permanentDeleteAfterDays || PERMANENT_DELETE_AFTER_DAYS)
    };
    store.users[target.user.id].updatedAt = nowIso();
    return store.users[target.user.id].settings;
  });
  res.json({ ok: true, settings: result });
});

app.get("/summaries", (req, res) => {
  const deviceId = String(req.query.deviceId || "");
  const store = loadStore();
  const target = resolveSummaryTarget(store, deviceId);
  const list = Object.values(store.summaries)
    .filter(s => s.userId === target?.user?.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30);
  res.json({ summaries: list });
});

app.post("/summarize/run", async (req, res) => {
  const body = req.body || {};
  res.type("application/json");

  try {
    const { deviceId = "" } = body;
    const mode = getSummaryMode(body);
    const store = loadStore();
    const target = resolveSummaryTarget(store, deviceId);

    if (!target?.user || !target?.device) {
      return sendSummaryJson(res, {
        ok: false,
        mode,
        processed: 0,
        error: "Device not linked"
      });
    }

    const options = normalizeSummaryOptions(body, target.user);
    const result = await runSummaryForUser(target.user, target.device, store, options);

    saveStore(store);

    if (!result.ok && result.processed === 0) {
      return sendSummaryJson(res, {
        ok: false,
        mode: result.mode,
        processed: 0,
        message: result.message
      });
    }

    return sendSummaryJson(res, {
      ok: true,
      mode: result.mode,
      processed: result.processed,
      summary: result.content,
      startTime: result.startTime,
      endTime: result.endTime,
      importantCount: result.importantCount,
      spamCount: result.spamCount,
      hasMore: Boolean(result.hasMore)
    });
  } catch (err) {
    console.error("Summarize run failed", err);
    return sendSummaryError(res, body, err);
  }
});

async function getMessagesForSummary(user, store, options) {
  if (USE_IMAP) {
    const result = await getUnreadImapMessagesForSummary(options);
    if (options.mode !== "scheduled") return result;

    const limit = positiveInt(options.maxMessages, 30, 100);
    const filtered = result.messages
      .filter(message => !store.summarizedMessages?.[message.id])
      .sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));

    return {
      messages: filtered.slice(0, limit),
      hasMore: Boolean(result.hasMore || filtered.length > limit)
    };
  }

  const allMessages = await getUnreadMessages(await getFreshAccessToken(user, store));
  return filterMessagesByWindow(allMessages, options, store);
}

async function runSummaryForUser(user, device, store, options = getScheduledOptionsForUser(user)) {
  const summaryOptions = options?.mode ? options : getScheduledOptionsForUser(user);
  const { messages, hasMore } = await getMessagesForSummary(user, store, summaryOptions);
  const mode = summaryOptions.mode === "test" ? "test" : "scheduled";
  const processed = messages.length;

  if (processed === 0) {
    return {
      ok: false,
      mode,
      processed: 0,
      hasMore: false,
      message: mode === "test" ? "没有可总结的邮件" : "当前时间范围内没有可总结的新邮件"
    };
  }

  const meta = buildSummaryMeta(messages, summaryOptions);
  const content = await summarizeMessages(messages, user.settings, meta);

  if (mode === "scheduled") {
    for (const message of messages) {
      store.summarizedMessages[message.id] = {
        userId: user.id,
        messageId: message.id,
        uid: message.uid,
        mailbox: message.mailbox,
        subject: message.subject,
        webLink: message.webLink || "",
        summarizedAt: nowIso(),
        sourceFolder: message.sourceFolder,
        provider: USE_IMAP ? "imap" : "graph"
      };
    }
    user.lastRunAt = nowIso();
    store.users[user.id] = user;
  }

  const title = USE_IMAP ? "QQ 邮箱邮件总结" : "Outlook 邮件总结";
  const summaryId = makeId("summary");
  const summary = {
    id: summaryId,
    userId: user.id,
    title,
    content,
    mode,
    processed,
    hasMore,
    startTime: meta.startTime,
    endTime: meta.endTime,
    importantCount: meta.importantCount,
    spamCount: meta.spamCount,
    unreadCount: processed,
    junkUnreadCount: messages.filter(m => m.sourceFolder === "junkemail").length,
    windowHours: summaryOptions.windowHours || null,
    createdAt: nowIso()
  };

  store.summaries[summaryId] = summary;

  if (mode === "scheduled") {
    await sendSummaryPush(device.deviceToken, title, trimPushBody(content), summaryId);
  }

  return {
    ok: true,
    mode,
    processed,
    content,
    startTime: meta.startTime,
    endTime: meta.endTime,
    importantCount: meta.importantCount,
    spamCount: meta.spamCount,
    hasMore,
    summaryRecord: summary
  };
}

async function cleanupForUser(user, store) {
  if (!AUTO_DELETE_ENABLED || user.settings?.autoDeleteEnabled === false) return { skipped: true };
  const deleteAfter = Number(user.settings?.deleteAfterDays || DELETE_AFTER_DAYS);

  if (USE_IMAP) {
    return cleanupImapMessages(store, user, deleteAfter);
  }

  const accessToken = await getFreshAccessToken(user, store);
  const keepDeletedDays = Number(user.settings?.permanentDeleteAfterDays || PERMANENT_DELETE_AFTER_DAYS);
  const cutoff = Date.now() - deleteAfter * 24 * 60 * 60 * 1000;
  const moved = [];

  const oldRead = await getReadOlderThan(accessToken, deleteAfter);
  for (const message of oldRead) {
    try {
      await moveToDeletedItems(accessToken, message.id);
      store.deletedMessages[message.id] = { userId: user.id, messageId: message.id, deletedAt: nowIso(), reason: "read_older_than_retention_days" };
      moved.push(message.id);
    } catch (err) {
      console.warn("Move read message failed", message.id, err.message);
    }
  }

  for (const record of Object.values(store.summarizedMessages).filter(r => r.userId === user.id)) {
    if (new Date(record.summarizedAt).getTime() > cutoff) continue;
    if (store.deletedMessages[record.messageId]) continue;
    try {
      await moveToDeletedItems(accessToken, record.messageId);
      store.deletedMessages[record.messageId] = { userId: user.id, messageId: record.messageId, deletedAt: nowIso(), reason: "summarized_older_than_retention_days" };
      moved.push(record.messageId);
    } catch (err) {
      console.warn("Move summarized message failed", record.messageId, err.message);
    }
  }

  const permanentCutoff = Date.now() - keepDeletedDays * 24 * 60 * 60 * 1000;
  const permanentlyDeleted = [];
  for (const record of Object.values(store.deletedMessages).filter(r => r.userId === user.id)) {
    if (new Date(record.deletedAt).getTime() > permanentCutoff) continue;
    try {
      await permanentDelete(accessToken, record.messageId);
      permanentlyDeleted.push(record.messageId);
      delete store.deletedMessages[record.messageId];
    } catch (err) {
      console.warn("Permanent delete failed", record.messageId, err.message);
    }
  }

  return { moved: moved.length, permanentlyDeleted: permanentlyDeleted.length };
}

async function schedulerTick() {
  const store = loadStore();
  for (const user of Object.values(store.users)) {
    const device = store.devices[user.deviceId];
    try {
      if (isDue(user)) await runSummaryForUser(user, device || {}, store, getScheduledOptionsForUser(user));
      await cleanupForUser(user, store);
    } catch (err) {
      console.error("Scheduled job failed", user.id, err.message);
    }
  }
  saveStore(store);
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  console.error("Unhandled request error", err);
  if (req.path === "/summarize/run") {
    return sendSummaryError(res, req.body || {}, err);
  }

  return res.status(500).type("application/json").json({
    ok: false,
    error: err?.message || "Internal server error"
  });
});

setInterval(schedulerTick, 15 * 60 * 1000);
setTimeout(schedulerTick, 2000);

app.listen(PORT, () => {
  console.log(`Outlook AI Summary backend running on port ${PORT}`);
});
