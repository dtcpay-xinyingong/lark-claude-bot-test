from http.server import BaseHTTPRequestHandler
import json
import os
import urllib.request
import urllib.parse

def get_lark_token():
    """Get Lark tenant access token."""
    url = "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal"
    data = json.dumps({
        "app_id": os.environ["LARK_APP_ID"],
        "app_secret": os.environ["LARK_APP_SECRET"]
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
        "x-api-key": os.environ["CLAUDE_API_KEY"],
        "anthropic-version": "2023-06-01"
    })

    with urllib.request.urlopen(req) as res:
        result = json.loads(res.read())
        return result["content"][0]["text"]


def reply_to_lark(message_id: str, text: str):
    """Send reply back to Lark channel."""
    token = get_lark_token()
    url = f"https://open.larksuite.com/open-apis/im/v1/messages/{message_id}/reply"

    # Escape text for JSON
    escaped_text = text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')

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


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Read request body
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        data = json.loads(body)

        # Handle URL verification (Lark sends this when setting up webhook)
        if "challenge" in data:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"challenge": data["challenge"]}).encode())
            return

        # Handle message event
        event = data.get("event", {})
        message = event.get("message")

        if message:
            message_id = message["message_id"]
            content = json.loads(message.get("content", "{}"))
            user_text = content.get("text", "")

            # Remove @mention from the message (Lark format: @_user_xxx)
            import re
            user_text = re.sub(r'@_user_\d+\s*', '', user_text).strip()

            if user_text:
                try:
                    # Get Claude's response
                    claude_response = call_claude(user_text)
                    # Reply in Lark channel
                    reply_to_lark(message_id, claude_response)
                except Exception as e:
                    print(f"Error: {e}")
                    reply_to_lark(message_id, f"Sorry, I encountered an error: {str(e)}")

        # Return success
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())
