# WhatsApp Skill for Nonnaclaw

MCP server wrapping [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp integration. Runs as a persistent MCP server on the host, spawned by the MCP bridge. Containers access it via HTTP proxy with per-group tool scoping.

## Setup

1. Clone into your `skills/` directory:
   ```bash
   cd skills/
   git clone https://github.com/nickdirienzo/nonnaclaw-whatsapp whatsapp
   cd whatsapp
   npm install
   npm run build
   ```

2. Authenticate with WhatsApp:
   ```bash
   # QR code method (default)
   npm run auth

   # Pairing code method (no camera needed)
   npm run auth -- --pairing-code --phone 14155551234
   ```

3. Set environment variables in your project `.env`:
   ```
   ASSISTANT_NAME=YourAssistantName
   ASSISTANT_HAS_OWN_NUMBER=false
   ```
   - `ASSISTANT_NAME`: Name prefix for outbound messages (when `ASSISTANT_HAS_OWN_NUMBER=false`)
   - `ASSISTANT_HAS_OWN_NUMBER`: Set `true` if the assistant has its own WhatsApp number (no name prefix needed)

4. Authorize groups. For each group that should have WhatsApp access, add to its `authorizedSkills`:
   ```json
   {
     "authorizedSkills": {
       "whatsapp": {
         "pinnedParams": {
           "send_message.chat_id": "<group-jid>"
         }
       }
     }
   }
   ```
   The `chat_id` parameter is pinned per-group so each agent can only send messages to its own chat.

5. Restart the service. The MCP bridge will spawn the WhatsApp MCP server and expose it to containers.

## Architecture

```
Host (MCP Bridge)
├── Spawns: node skills/whatsapp/dist/mcp-server.js (stdio)
├── Connects as MCP client
├── Polls: list_new_messages every 3s → InboxEvents
└── Exposes: HTTP endpoint on localhost:{port}/mcp

Container (MCP Proxy)
├── Connects to host HTTP endpoint
├── Applies scopeTemplate rules (tool allowlist + param pinning)
└── Agent calls: send_message, search_contacts
```

## MCP Tools

| Tool | Description | Scoped |
|------|-------------|--------|
| `send_message` | Send a WhatsApp message | `chat_id` pinned per-group |
| `list_new_messages` | Get messages since timestamp (polling) | Allowed |
| `list_chats` | List available chats/groups | Blocked by default |
| `search_contacts` | Search contacts by name/number | Allowed |

## Auth state

Stored in `store/auth/` — persists across restarts. If auth fails, delete `store/auth/` and run `npm run auth` again.
