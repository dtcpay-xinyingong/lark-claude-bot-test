// Upstash Redis for deduplication and conversation memory
const REDIS_URL = () => process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL()}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN()}` },
  });
  const data = await res.json();
  return data.result;
}

async function redisSet(key, value, exSeconds = null) {
  const url = exSeconds
    ? `${REDIS_URL()}/set/${key}?EX=${exSeconds}`
    : `${REDIS_URL()}/set/${key}`;
  // Value is already a string, don't double-stringify
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN()}`,
    },
    body: value,
  });
}

async function redisDel(key) {
  await fetch(`${REDIS_URL()}/del/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN()}` },
  });
}

async function checkAndSetMessage(messageId) {
  const exists = await redisGet(`msg:${messageId}`);
  if (exists) return true;
  await redisSet(`msg:${messageId}`, "1", 300);
  return false;
}

// Conversation memory functions
async function getConversationHistory(sessionId) {
  const history = await redisGet(`session:${sessionId}`);
  if (history) {
    try {
      return JSON.parse(history);
    } catch {
      return [];
    }
  }
  return [];
}

async function saveConversationHistory(sessionId, messages) {
  // Keep last 50 messages
  const trimmed = messages.slice(-50);
  // Expire after 6 hours (21600 seconds)
  await redisSet(`session:${sessionId}`, JSON.stringify(trimmed), 21600);
}

async function clearConversationHistory(sessionId) {
  await redisDel(`session:${sessionId}`);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok" });
  }

  if (req.method === "POST") {
    const data = req.body || {};

    if (data.challenge) {
      return res.status(200).json({ challenge: data.challenge });
    }

    const event = data.event || {};
    const message = event.message;

    if (!message) {
      return res.status(200).json({ ok: true });
    }

    const messageId = message.message_id;
    const chatId = message.chat_id;
    // Use root_id for thread/topic, fall back to chat_id for non-threaded messages
    const rootId = message.root_id;
    const sessionId = rootId || chatId;

    // Deduplication
    try {
      const isDuplicate = await checkAndSetMessage(messageId);
      if (isDuplicate) {
        console.log("Duplicate message, skipping:", messageId);
        return res.status(200).json({ ok: true, skipped: "duplicate" });
      }
    } catch (e) {
      console.log("Redis error:", e.message);
    }

    // Skip bot messages
    const senderType = event.sender?.sender_type;
    if (senderType === "app") {
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

    // Handle /clear command
    if (userText.toLowerCase() === "/clear") {
      await clearConversationHistory(sessionId);
      await replyToLark(messageId, "Conversation history cleared for this topic.");
      return res.status(200).json({ ok: true, cleared: true });
    }

    try {
      console.log("Processing message:", userText);
      console.log("Session ID (topic/thread):", sessionId);

      // Get conversation history for this topic
      let history = await getConversationHistory(sessionId);

      // Add user message to history
      history.push({ role: "user", content: userText });

      // Call Claude with full history
      const claudeResponse = await callClaude(history);
      console.log("Claude response received");

      // Add assistant response to history
      history.push({ role: "assistant", content: claudeResponse });

      // Save updated history
      await saveConversationHistory(sessionId, history);

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

async function callClaude(messages) {
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
      system:
        "You are a helpful assistant in a Lark group chat. Keep responses concise but helpful. You remember previous messages in this conversation thread.",
      messages: messages,
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
