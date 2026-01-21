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

    if (message) {
      const messageId = message.message_id;
      let content = {};

      try {
        content = JSON.parse(message.content || "{}");
      } catch (e) {
        content = {};
      }

      let userText = content.text || "";
      // Remove @mention
      userText = userText.replace(/@_user_\d+\s*/g, "").trim();

      if (userText && messageId) {
        try {
          const claudeResponse = await callClaude(userText);
          await replyToLark(messageId, claudeResponse);
        } catch (error) {
          console.error("Error:", error);
        }
      }
    }

    return res.status(200).json({ ok: true });
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
  await fetch(
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
}
