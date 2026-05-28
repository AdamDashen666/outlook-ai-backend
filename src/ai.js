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
    .trim();
}

export async function summarizeMessages(messages, settings = {}, summaryMeta = {}) {
  const { apiKey, baseUrl, model } = getAiConfig(settings);
  if (!apiKey) throw new Error("Missing AI API key");

  const compactMessages = messages.map((m, index) => ({
    index: index + 1,
    folder: m.sourceFolder === "junkemail" ? "垃圾邮件" : "收件箱",
    subject: m.subject || "无标题",
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "未知发件人",
    email: m.from?.emailAddress?.address || "",
    receivedDateTime: m.receivedDateTime,
    preview: m.bodyPreview || ""
  }));

  const startTime = summaryMeta.startTime || "未知";
  const endTime = summaryMeta.endTime || "未知";
  const processedCount = Number(summaryMeta.processedCount || messages.length || 0);
  const importantCount = Number(summaryMeta.importantCount || 0);
  const spamCount = Number(summaryMeta.spamCount || 0);

  const outputTemplate = `【邮件总结】
时间范围：${startTime} - ${endTime}
处理邮件：${processedCount} 封
重要邮件：${importantCount} 封
垃圾/低价值邮件：${spamCount} 封

一、重点提醒

1. {最重要的事情，用一句话总结}
2. {需要用户处理的事情}
3. {可能有风险/截止时间的事情}

二、重要邮件

1. 发件人：{sender}
    主题：{subject}
    时间：{time}
    摘要：{用 1-2 句话说明邮件内容}
    需要操作：{回复 / 查看 / 付款 / 确认 / 无需操作}
    截止时间：{如果有就写，没有写“无”}
    优先级：高 / 中 / 低

三、普通邮件

* {普通邮件的合并总结，不要逐封写太长}

四、垃圾邮件 / 可忽略邮件

* {简单说明垃圾邮件类型，比如广告、验证码、促销、订阅通知}
* 不要展开无价值内容

五、风险提醒

* {可疑链接 / 付款要求 / 登录提醒 / 验证码 / 账号异常}
* 如果没有风险，写：暂无明显风险

六、下一步建议

* {建议用户优先处理什么}`;

  const prompt = `你是严谨、简洁的中文邮件总结助手。请根据下面的邮件数据输出邮件总结。\n\n` +
    `硬性要求：\n` +
    `1. 必须严格使用指定格式输出，保留中文编号和换行。\n` +
    `2. summary 正文不要输出 JSON。\n` +
    `3. 不要输出多余解释、前言、后记。\n` +
    `4. 尽量不要使用 Markdown 加粗符号 **，不要使用 ### 标题。\n` +
    `5. 不要编造邮件里没有的信息；没有截止时间就写“无”。\n` +
    `6. 重要邮件最多列 8 封；普通邮件和垃圾邮件合并概括。\n\n` +
    `必须使用以下格式：\n\n${outputTemplate}\n\n` +
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
        { role: "system", content: "你是严谨、简洁的中文邮件总结助手，只按用户指定格式输出。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    })
  });

  if (!res.ok) throw new Error(`AI summary failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return cleanAiSummary(data.choices?.[0]?.message?.content || "没有生成总结。");
}
