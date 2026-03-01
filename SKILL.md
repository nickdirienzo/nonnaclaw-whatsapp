# WhatsApp Skill for Nonnaclaw

WhatsApp integration using the community [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) server. No custom WhatsApp code — just config around the community MCP.

## Prerequisites

- **Go** (for the WhatsApp bridge): `brew install go` (macOS) or [go.dev/dl](https://go.dev/dl/)
- **uv** (for the Python MCP server): `brew install uv` (macOS) or `curl -LsSf https://astral.sh/uv/install.sh | sh`

## Setup

### 1. Clone the community MCP server

```bash
cd skills/whatsapp
git clone https://github.com/lharries/whatsapp-mcp.git
```

### 2. Build and start the Go bridge

The Go bridge maintains the WhatsApp WebSocket connection and stores messages in SQLite.

```bash
cd whatsapp-mcp/whatsapp-bridge
go build -o whatsapp-bridge .
./whatsapp-bridge
```

On first run, scan the QR code with WhatsApp (Settings > Linked Devices > Link a Device). The bridge saves auth state in `store/` and will reconnect automatically on restart.

### 3. Keep the Go bridge running as a service

The Go bridge must be running for the MCP server to work.

**macOS (launchd):**
Create `~/Library/LaunchAgents/com.whatsapp-bridge.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.whatsapp-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>BRIDGE_BINARY_PATH</string>
    </array>
    <key>WorkingDirectory</key>
    <string>BRIDGE_WORKING_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>BRIDGE_WORKING_DIR/bridge.log</string>
    <key>StandardErrorPath</key>
    <string>BRIDGE_WORKING_DIR/bridge.error.log</string>
</dict>
</plist>
```
Replace `BRIDGE_BINARY_PATH` with the absolute path to the compiled `whatsapp-bridge` binary and `BRIDGE_WORKING_DIR` with the absolute path to `skills/whatsapp/whatsapp-mcp/whatsapp-bridge`.

Then: `launchctl load ~/Library/LaunchAgents/com.whatsapp-bridge.plist`

**Linux (systemd):**
```bash
systemctl --user enable --now whatsapp-bridge  # after creating a unit file
```

### 4. Configure the Python MCP server

Create a `.env` file in the MCP server directory:
```bash
cat > whatsapp-mcp/whatsapp-mcp-server/.env << 'EOF'
WHATSAPP_DB_PATH=../whatsapp-bridge/store/messages.db
BRIDGE_API_URL=http://localhost:8080
EOF
```

### 5. Authorize groups

For each group that should have WhatsApp access, update its registration with `authorizedSkills`. The `scopedParams` pin each agent to its own chat:

```json
{
  "authorizedSkills": {
    "whatsapp": {
      "pinnedParams": {
        "send_message.recipient": "<group-jid>",
        "list_messages.chat_jid": "<group-jid>",
        "get_chat.chat_jid": "<group-jid>",
        "get_contact_chats.jid": "<group-jid>",
        "get_last_interaction.jid": "<group-jid>",
        "send_file.recipient": "<group-jid>",
        "send_audio_message.recipient": "<group-jid>"
      }
    }
  }
}
```

The main group typically has no pinned params (full access to all chats).

### 6. Restart nonnaclaw

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

The MCP bridge will spawn the Python MCP server via `uv`, connect over stdio, and expose it to containers via HTTP.

## Architecture

```
Go bridge (separate service)         ← WhatsApp WebSocket, SQLite
    ↕ HTTP (localhost:8080)
Python MCP server (spawned by bridge) ← stdio MCP, 12 tools
    ↕ stdio
Nonnaclaw MCP bridge                 ← polls list_messages, HTTP endpoint
    ↕ HTTP (localhost:PORT/mcp)
Container MCP proxy                  ← scopeTemplate rules, param pinning
    ↕ stdio
Claude agent                         ← calls send_message, search_contacts, etc.
```

## MCP Tools (from lharries/whatsapp-mcp)

| Tool | Description | Scoped |
|------|-------------|--------|
| `send_message` | Send a text message | `recipient` pinned per-group |
| `send_file` | Send a file/image | `recipient` pinned per-group |
| `send_audio_message` | Send audio as voice note | `recipient` pinned per-group |
| `list_messages` | List messages with date filtering | `chat_jid` pinned per-group |
| `list_chats` | List all chats | Blocked by default |
| `search_contacts` | Search contacts | Allowed |
| `get_chat` | Get chat details | `chat_jid` pinned per-group |
| `get_direct_chat_by_contact` | Find DM by phone number | Allowed |
| `get_contact_chats` | Get chats for a contact | `jid` pinned per-group |
| `get_last_interaction` | Last interaction with contact | `jid` pinned per-group |
| `get_message_context` | Get context around a message | Allowed |
| `download_media` | Download media from a message | Allowed |

## Troubleshooting

- **"Failed to start MCP bridge"**: Check that the Go bridge is running (`curl http://localhost:8080/api/health`) and that `uv` is installed
- **No inbound messages**: Check that `list_messages` returns data (`curl http://localhost:8080/api/messages` or check the Go bridge's SQLite)
- **Auth expired**: Re-scan QR code by restarting the Go bridge after deleting `whatsapp-mcp/whatsapp-bridge/store/`
