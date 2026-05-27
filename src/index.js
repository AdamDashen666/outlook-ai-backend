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
  getUnreadImapMessages,
  markImapMessageSummarized,
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
      const info = getImapAccountInfo();
      const userId = "imap_default_user";
      baseDevice.userId = userId;
      store.users[userId] = {
        ...(store.users[userId] || {}),
        id: userId,
        deviceId,
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
          ...stripAiSettings(store.users[userId]?.settings || {})
        },
        updatedAt: nowIso()
      };
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
  const device = store.devices[deviceId];
  const user = device?.userId ? store.users[device.userId] : null;
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
    const device = store.devices[deviceId];
    if (!device?.userId || !store.users[device.userId]) throw new Error("Device not linked");
    const current = stripAiSettings(store.users[device.userId].settings || {});
    const safeSettings = stripAiSettings(settings);
    store.users[device.userId].settings = {
      ...current,
      ...safeSettings,
      language: "zh-CN",
      includeJunkUnread: true,
      autoDeleteEnabled: safeSettings.autoDeleteEnabled ?? current.autoDeleteEnabled ?? true,
      deleteAfterDays: Number(safeSettings.deleteAfterDays || current.deleteAfterDays || DELETE_AFTER_DAYS),
      permanentDeleteAfterDays: Number(safeSettings.permanentDeleteAfterDays || current.permanentDeleteAfterDays || PERMANENT_DELETE_AFTER_DAYS)
    };
    store.users[device.userId].updatedAt = nowIso();
    return store.users[device.userId].settings;
  });
  res.json({ ok: true, settings: result });
});

app.get("/summaries", (req, res) => {
  const deviceId = String(req.query.deviceId || "");
  const store = loadStore();
  const device = store.devices[deviceId];
  const list = Object.values(store.summaries)
    .filter(s => s.userId === device?.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30);
  res.json({ summaries: list });
});

app.post("/summarize/run", async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    const store = loadStore();
    const device = store.devices[deviceId];
    if (!device?.userId) return res.status(400).json({ error: "Device not linked" });
    const user = store.users[device.userId];
    const summary = await runSummaryForUser(user, device, store);
    saveStore(store);
    res.json({ ok: true, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

async function runSummaryForUser(user, device, store) {
  const messages = USE_IMAP ? await getUnreadImapMessages() : await getUnreadMessages(await getFreshAccessToken(user, store));
  const summaryId = makeId("summary");
  let content = "没有新的未读邮件。";

  if (messages.length > 0) {
    content = await summarizeMessages(messages, user.settings);
    for (const message of messages) {
      try {
        if (USE_IMAP) {
          await markImapMessageSummarized(message);
        } else {
          const accessToken = await getFreshAccessToken(user, store);
          await markMessageSummarized(accessToken, message);
        }

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
      } catch (err) {
        console.warn("Failed to mark summarized", message.id, err.message);
      }
    }
  }

  const title = USE_IMAP ? "QQ 邮箱邮件总结" : "Outlook 邮件总结";
  const summary = {
    id: summaryId,
    userId: user.id,
    title,
    content,
    unreadCount: messages.length,
    junkUnreadCount: messages.filter(m => m.sourceFolder === "junkemail").length,
    createdAt: nowIso()
  };
  store.summaries[summaryId] = summary;
  user.lastRunAt = nowIso();
  store.users[user.id] = user;

  await sendSummaryPush(device.deviceToken, title, trimPushBody(content), summaryId);
  return summary;
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
      if (isDue(user)) await runSummaryForUser(user, device || {}, store);
      await cleanupForUser(user, store);
    } catch (err) {
      console.error("Scheduled job failed", user.id, err.message);
    }
  }
  saveStore(store);
}

setInterval(schedulerTick, 15 * 60 * 1000);
setTimeout(schedulerTick, 2000);

app.listen(PORT, () => {
  console.log(`Outlook AI Summary backend running on port ${PORT}`);
});
