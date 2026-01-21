// Upstash Redis for deduplication
async function checkAndSetMessage(messageId) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Check if message already processed
  const getRes = await fetch(`${url}/get/msg:${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const getData = await getRes.json();

  if (getData.result) {
    return true; // Already processed
  }

  // Mark as processed (expires in 5 minutes)
  await fetch(`${url}/set/msg:${messageId}/1?EX=300`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return false; // Not a duplicate
}

export default async function handler(req, res) {
  // Handle GET request (health check)
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok" });
  }

  // Handle POST request
  if (req.method === "POST") {
    const data = req.body || {};

    // Handle Lark URL verification
    if (data.challenge) {
      return res.status(200).json({ challenge: data.challenge });
    }

    // Handle message event
    const event = data.event || {};
    const message = event.message;

    if (!message) {
      return res.status(200).json({ ok: true });
    }

    const messageId = message.message_id;

    // Check for duplicate using Upstash Redis
    try {
      const isDuplicate = await checkAndSetMessage(messageId);
      if (isDuplicate) {
        console.log("Duplicate message, skipping:", messageId);
        return res.status(200).json({ ok: true, skipped: "duplicate" });
      }
    } catch (e) {
      console.log("Redis error (continuing anyway):", e.message);
    }

    // Skip bot messages
    const senderType = event.sender?.sender_type;
    if (senderType === "app") {
      console.log("Bot message, skipping");
      return res.status(200).json({ ok: true, skipped: "bot" });
    }

    let content = {};
    try {
      content = JSON.parse(message.content || "{}");
    } catch (e) {
      content = {};
    }

    let userText = content.text || "";
    userText = userText.replace(/@_user_\d+\s*/g, "").trim();

    if (!userText || !messageId) {
      return res.status(200).json({ ok: true, skipped: "no text" });
    }

    try {
      console.log("Processing message:", userText);
      const claudeResponse = await callClaude(userText);
      console.log("Claude response received");
      await replyToLark(messageId, claudeResponse);
      console.log("Reply sent to Lark");
      return res.status(200).json({ ok: true, replied: true });
    } catch (error) {
      console.error("Error:", error);
      return res.status(200).json({ ok: false, error: error.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function getLarkToken() {
  const response = await fetch(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }),
    }
  );
  const data = await response.json();
  return data.tenant_access_token;
}

async function callClaude(userMessage) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await response.json();
  return data.content[0].text;
}

async function replyToLark(messageId, text) {
  const token = await getLarkToken();
  const response = await fetch(
    `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: JSON.stringify({ text }),
        msg_type: "text",
      }),
    }
  );
  const data = await response.json();
  console.log("Lark reply response:", data);
  return data;
}
