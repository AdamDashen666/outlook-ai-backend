export function getAiConfig(settings = {}) {
  return {
    apiKey: process.env.AI_API_KEY || settings.aiApiKey,
    baseUrl: process.env.AI_BASE_URL || settings.aiBaseUrl || "https://api.deepseek.com/chat/completions",
    model: process.env.AI_MODEL || settings.aiModel || "deepseek-v4-flash"
  };
}

function cleanAiSummary(text = "") {
  return String(text)
    .replace(/\*\*/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanInline(text = "") {
  return cleanAiSummary(text).replace(/\s+/g, " ").trim();
}

function toStringArray(value, fallback = ["无"]) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map(item => cleanInline(item)).filter(Boolean);
  return cleaned.length ? cleaned : fallback;
}

function normalizePriority(value = "") {
  const text = cleanInline(value);
  if (["高", "中", "低"].includes(text)) return text;
  if (/high|urgent|重要|紧急/i.test(text)) return "高";
  if (/low|普通|低/i.test(text)) return "低";
  return "中";
}

function normalizeImportantEmails(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(item => ({
    sender: cleanInline(item?.sender || "未知发件人"),
    subject: cleanInline(item?.subject || "无标题"),
    time: cleanInline(item?.time || "未知"),
    summary: cleanInline(item?.summary || "无"),
    action: cleanInline(item?.action || "无需操作"),
    deadline: cleanInline(item?.deadline || "无"),
    priority: normalizePriority(item?.priority || "中")
  }));
}

function fallbackStructured(messages, summaryMeta = {}) {
  const startTime = summaryMeta.startTime || "未知";
  const endTime = summaryMeta.endTime || "未知";
  const processed = Number(summaryMeta.processedCount || messages.length || 0);
  const important = Number(summaryMeta.importantCount || 0);
  const spam = Number(summaryMeta.spamCount || 0);

  const importantEmails = messages.slice(0, Math.min(important || messages.length, 8)).map(message => ({
    sender: message.from?.emailAddress?.name || message.from?.emailAddress?.address || "未知发件人",
    subject: message.subject || "无标题",
    time: message.receivedDateTime || "未知",
    summary: cleanInline(message.bodyPreview || "无" ).slice(0, 160) || "无",
    action: "查看",
    deadline: "无",
    priority: important ? "高" : "中"
  }));

  return {
    title: "邮件总结",
    timeRange: {
      start: startTime,
      end: endTime
    },
    counts: {
      processed,
      important,
      spam
    },
    reminders: processed ? ["请查看本次邮件总结中的重点内容。"] : ["无"],
    importantEmails,
    normalEmailsSummary: processed ? ["其余邮件多为普通通知或常规信息。"] : ["无"],
    spamSummary: spam ? ["存在广告、促销、订阅通知或低价值邮件。"] : ["无"],
    risks: ["暂无明显风险"],
    nextSteps: processed ? ["优先处理高优先级和涉及账号、安全、付款或截止时间的邮件。"] : ["无"]
  };
}

function normalizeStructured(value, messages, summaryMeta = {}) {
  const fallback = fallbackStructured(messages, summaryMeta);
  const source = value && typeof value === "object" ? value : {};
  const counts = source.counts && typeof source.counts === "object" ? source.counts : {};
  const timeRange = source.timeRange && typeof source.timeRange === "object" ? source.timeRange : {};

  return {
    title: cleanInline(source.title || fallback.title),
    timeRange: {
      start: cleanInline(timeRange.start || fallback.timeRange.start),
      end: cleanInline(timeRange.end || fallback.timeRange.end)
    },
    counts: {
      processed: Number(counts.processed ?? fallback.counts.processed),
      important: Number(counts.important ?? fallback.counts.important),
      spam: Number(counts.spam ?? fallback.counts.spam)
    },
    reminders: toStringArray(source.reminders, fallback.reminders),
    importantEmails: normalizeImportantEmails(source.importantEmails).length
      ? normalizeImportantEmails(source.importantEmails)
      : fallback.importantEmails,
    normalEmailsSummary: toStringArray(source.normalEmailsSummary, fallback.normalEmailsSummary),
    spamSummary: toStringArray(source.spamSummary, fallback.spamSummary),
    risks: toStringArray(source.risks, fallback.risks),
    nextSteps: toStringArray(source.nextSteps, fallback.nextSteps)
  };
}

function extractJsonObject(text = "") {
  const raw = String(text || "").trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }

  return null;
}

export async function summarizeMessages(messages, settings = {}, summaryMeta = {}) {
  const { apiKey, baseUrl, model } = getAiConfig(settings);
  if (!apiKey) throw new Error("Missing AI API key");

  const compactMessages = messages.map((m, index) => ({
    index: index + 1,
    folder: m.sourceFolder === "junkemail" ? "垃圾邮件" : "收件箱",
    sender: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "未知发件人",
    email: m.from?.emailAddress?.address || "",
    subject: m.subject || "无标题",
    time: m.receivedDateTime,
    preview: m.bodyPreview || ""
  }));

  const startTime = summaryMeta.startTime || "未知";
  const endTime = summaryMeta.endTime || "未知";
  const processedCount = Number(summaryMeta.processedCount || messages.length || 0);
  const importantCount = Number(summaryMeta.importantCount || 0);
  const spamCount = Number(summaryMeta.spamCount || 0);

  const summaryTemplate = `【邮件总结】
时间范围：${startTime} - ${endTime}
处理邮件：${processedCount} 封
重要邮件：${importantCount} 封
垃圾/低价值邮件：${spamCount} 封

一、重点提醒
1. ...
2. ...
3. ...

二、重要邮件
1. 发件人：...
   主题：...
   时间：...
   摘要：...
   需要操作：...
   截止时间：...
   优先级：...

三、普通邮件
- ...

四、垃圾邮件 / 可忽略邮件
- ...

五、风险提醒
- ...

六、下一步建议
- ...`;

  const structuredTemplate = {
    title: "邮件总结",
    timeRange: { start: startTime, end: endTime },
    counts: { processed: processedCount, important: importantCount, spam: spamCount },
    reminders: ["每条提醒独立一行"],
    importantEmails: [
      {
        sender: "发件人",
        subject: "主题",
        time: "时间",
        summary: "1-2句话摘要",
        action: "查看",
        deadline: "无",
        priority: "高"
      }
    ],
    normalEmailsSummary: ["普通邮件合并总结"],
    spamSummary: ["垃圾/低价值邮件合并总结，若无则写无"],
    risks: ["如果没有风险，写：暂无明显风险"],
    nextSteps: ["下一步建议"]
  };

  const prompt = `你是严谨、简洁的中文邮件总结助手。请根据邮件数据返回一个严格 JSON 对象，便于后端解析。\n\n` +
    `返回要求：\n` +
    `1. 只返回 JSON 对象，不要包裹 Markdown 代码块。\n` +
    `2. JSON 必须包含两个顶层字段：summary 和 structured。\n` +
    `3. summary 是完整中文文字版总结，不是 JSON 字符串外的正文；必须严格使用下面的中文格式，保留中文编号和换行。\n` +
    `4. structured 是给前端/PDF 使用的结构化对象，字段必须齐全。\n` +
    `5. 不要使用 **，不要使用 ###。\n` +
    `6. 每个重要邮件字段必须换行；每条提醒必须独立一行；摘要控制在 1-2 句话。\n` +
    `7. 不要编造邮件里没有的信息；没有截止时间写“无”；没有风险写“暂无明显风险”。\n\n` +
    `summary 格式模板：\n${summaryTemplate}\n\n` +
    `structured 结构模板：\n${JSON.stringify(structuredTemplate, null, 2)}\n\n` +
    `邮件数据：\n${JSON.stringify(compactMessages, null, 2)}`;

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你只返回一个可解析 JSON 对象，不输出多余文字。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    })
  });

  if (!res.ok) throw new Error(`AI summary failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content || "";
  const parsed = extractJsonObject(rawContent);

  if (parsed?.summary || parsed?.structured) {
    const summary = cleanAiSummary(parsed.summary || rawContent);
    return {
      summary,
      structured: normalizeStructured(parsed.structured, messages, summaryMeta)
    };
  }

  const fallbackSummary = cleanAiSummary(rawContent || "没有生成总结。");
  return {
    summary: fallbackSummary,
    structured: normalizeStructured(null, messages, summaryMeta)
  };
}
