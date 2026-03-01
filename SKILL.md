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

### 2. Build and authenticate the Go bridge

The Go bridge maintains the WhatsApp WebSocket connection and stores messages in SQLite.

```bash
cd skills/whatsapp/whatsapp-mcp/whatsapp-bridge
go build -o whatsapp-bridge .
./whatsapp-bridge
```

On first run, a QR code appears in the terminal. Tell the user:

> Open WhatsApp on your phone > Settings > Linked Devices > Link a Device, then scan the QR code in the terminal.

Wait for `Connected` in the output, then stop the bridge (Ctrl+C). Auth state is saved in `store/` and persists.

### 3. Run the Go bridge as a service

The Go bridge must stay running. Generate a platform-appropriate service file using the actual resolved paths.

**macOS:** Write a launchd plist to `~/Library/LaunchAgents/com.whatsapp-bridge.plist` with:
- `ProgramArguments`: absolute path to the compiled `whatsapp-bridge` binary
- `WorkingDirectory`: absolute path to `skills/whatsapp/whatsapp-mcp/whatsapp-bridge`
- `KeepAlive: true`, `RunAtLoad: true`
- Log files in the working directory

Then load it: `launchctl load ~/Library/LaunchAgents/com.whatsapp-bridge.plist`

**Linux:** Write a systemd user unit and enable it.

Verify the bridge is running: `curl -s http://localhost:8080/api/contacts | head -c 100`

### 4. Configure the Python MCP server

```bash
cat > skills/whatsapp/whatsapp-mcp/whatsapp-mcp-server/.env << 'EOF'
WHATSAPP_DB_PATH=../whatsapp-bridge/store/messages.db
BRIDGE_API_URL=http://localhost:8080
EOF
```

### 5. Register chats

Ask the user which WhatsApp chat(s) to connect. Use `AskUserQuestion` to determine:

1. **Main chat or additional?** The main chat responds to all messages without a trigger. Additional chats require the trigger word.
2. **Which chat?** Get the WhatsApp JID. For personal/DM chats: `<phone>@s.whatsapp.net`. For groups: `<id>@g.us`.

If the user doesn't know their JID, query the Go bridge's database:
```bash
sqlite3 skills/whatsapp/whatsapp-mcp/whatsapp-bridge/store/messages.db "SELECT DISTINCT chat_jid FROM messages ORDER BY timestamp DESC LIMIT 20"
```

Register directly using the host's DB functions. Run from the project root:

#### Main chat (full access, no trigger required)

```bash
npx tsx -e "
import { initDatabase } from './src/db.js';
import { setRegisteredGroup } from './src/db.js';
initDatabase();
setRegisteredGroup('<whatsapp-jid>', {
  name: '<chat-name>',
  folder: 'main',
  trigger: '@<ASSISTANT_NAME>',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  authorizedSkills: {
    whatsapp: { pinnedParams: {} }
  }
});
console.log('Registered main chat');
"
```

The main chat gets unrestricted access to all WhatsApp tools — it can message any chat, list all chats, search contacts, etc.

#### Additional chats (scoped, trigger required)

```bash
npx tsx -e "
import { initDatabase } from './src/db.js';
import { setRegisteredGroup } from './src/db.js';
initDatabase();
setRegisteredGroup('<whatsapp-jid>', {
  name: '<chat-name>',
  folder: '<folder-name>',
  trigger: '@<ASSISTANT_NAME>',
  added_at: new Date().toISOString(),
  requiresTrigger: true,
  authorizedSkills: {
    whatsapp: {
      pinnedParams: {
        'send_message.recipient': '<whatsapp-jid>',
        'list_messages.chat_jid': '<whatsapp-jid>',
        'get_chat.chat_jid': '<whatsapp-jid>',
        'get_contact_chats.jid': '<whatsapp-jid>',
        'get_last_interaction.jid': '<whatsapp-jid>',
        'send_file.recipient': '<whatsapp-jid>',
        'send_audio_message.recipient': '<whatsapp-jid>'
      }
    }
  }
});
console.log('Registered additional chat');
"
```

The `folder` must be a unique, filesystem-safe name (lowercase, no spaces — e.g., `family-group`, `work-team`). Each folder gets its own isolated agent memory in `groups/<folder>/`.

To add WhatsApp authorization to an already-registered group, call `setRegisteredGroup` with the existing JID and folder — it upserts.

### 6. Restart nonnaclaw

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### 7. Verify

Tell the user to send a test message in their registered chat. Check logs:
```bash
tail -f logs/nanoclaw.log
```

Look for:
- `MCP bridge started` — bridge spawned the Python MCP server
- `Upstream MCP tools discovered` — tools enumerated
- Messages from `list_messages` polling

## Architecture

```
Go bridge (separate service)          <- WhatsApp WebSocket, SQLite
    | HTTP (localhost:8080)
Python MCP server (spawned by bridge) <- stdio MCP, 12 tools
    | stdio
Nonnaclaw MCP bridge                  <- polls list_messages, HTTP endpoint
    | HTTP (localhost:PORT/mcp)
Container MCP proxy                   <- scopeTemplate rules, param pinning
    | stdio
Claude agent                          <- calls send_message, search_contacts, etc.
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
- **No inbound messages**: Verify `list_messages` returns data: `curl http://localhost:8080/api/messages`
- **Auth expired**: Stop the bridge, delete `whatsapp-mcp/whatsapp-bridge/store/`, restart, and re-scan QR
