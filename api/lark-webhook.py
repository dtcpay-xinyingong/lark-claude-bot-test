from flask import Flask, request, jsonify
import json
import os
import re
import urllib.request

app = Flask(__name__)


def get_lark_token():
    """Get Lark tenant access token."""
    url = "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal"
    data = json.dumps({
        "app_id": os.environ.get("LARK_APP_ID"),
        "app_secret": os.environ.get("LARK_APP_SECRET")
    }).encode()

    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())["tenant_access_token"]


def call_claude(user_message: str) -> str:
    """Call Claude API and get response."""
    url = "https://api.anthropic.com/v1/messages"
    data = json.dumps({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": user_message}]
    }).encode()

    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        "x-api-key": os.environ.get("CLAUDE_API_KEY"),
        "anthropic-version": "2023-06-01"
    })

    with urllib.request.urlopen(req) as res:
        result = json.loads(res.read())
        return result["content"][0]["text"]


def reply_to_lark(message_id: str, text: str):
    """Send reply back to Lark channel."""
    token = get_lark_token()
    url = f"https://open.larksuite.com/open-apis/im/v1/messages/{message_id}/reply"

    data = json.dumps({
        "content": json.dumps({"text": text}),
        "msg_type": "text"
    }).encode()

    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    })

    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())


@app.route("/", methods=["GET", "POST"])
def webhook():
    # Handle GET request (basic health check)
    if request.method == "GET":
        return jsonify({"status": "ok"})

    data = request.get_json() or {}

    # Handle URL verification challenge from Lark
    if "challenge" in data:
        return jsonify({"challenge": data["challenge"]})

    # Handle message event
    event = data.get("event", {})
    message = event.get("message")

    if message:
        message_id = message.get("message_id")
        content_str = message.get("content", "{}")

        try:
            content = json.loads(content_str)
            user_text = content.get("text", "")

            # Remove @mention from the message
            user_text = re.sub(r'@_user_\d+\s*', '', user_text).strip()

            if user_text and message_id:
                claude_response = call_claude(user_text)
                reply_to_lark(message_id, claude_response)
        except Exception as e:
            print(f"Error processing message: {e}")

    return jsonify({"ok": True})
