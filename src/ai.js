export function getAiConfig(settings = {}) {
  return {
    apiKey: process.env.AI_API_KEY || settings.aiApiKey,
    baseUrl: process.env.AI_BASE_URL || settings.aiBaseUrl || "https://api.deepseek.com/chat/completions",
    model: process.env.AI_MODEL || settings.aiModel || "deepseek-v4-flash"
  };
}

export async function summarizeMessages(messages, settings = {}) {
  const { apiKey, baseUrl, model } = getAiConfig(settings);
  if (!apiKey) throw new Error("Missing AI API key");

  const compactMessages = messages.map((m, index) => ({
    index: index + 1,
    id: m.id,
    folder: m.sourceFolder === "junkemail" ? "垃圾邮件" : "收件箱",
    subject: m.subject || "无标题",
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "未知发件人",
    email: m.from?.emailAddress?.address || "",
    receivedDateTime: m.receivedDateTime,
    preview: m.bodyPreview || ""
  }));

  const prompt = `你是一个邮件助理。请用中文总结下面的 Outlook 未读邮件。要求：\n` +
    `1. 先给总览：重要邮件数量、普通邮件数量、垃圾邮件数量。\n` +
    `2. 列出最重要的 3-8 封邮件，每封包含：标题、发件人、重点、建议操作。\n` +
    `3. 垃圾邮件要单独标注，不要当成可信信息。\n` +
    `4. 不要编造邮件里没有的信息。\n` +
    `5. 输出简洁，适合手机通知点开后阅读。\n\n` +
    JSON.stringify(compactMessages, null, 2);

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是严谨、简洁的中文邮件总结助手。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    })
  });

  if (!res.ok) throw new Error(`AI summary failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "没有生成总结。";
}
