# WhatsApp Skill for NanoClaw

Connects NanoClaw to WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys). Runs as a persistent service that relays messages between WhatsApp and NanoClaw's inbox/outbox.

## Setup

1. Clone into your NanoClaw `skills/` directory:
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

3. Set environment variables in your NanoClaw `.env`:
   ```
   ASSISTANT_NAME=YourAssistantName
   ASSISTANT_HAS_OWN_NUMBER=false
   ```
   - `ASSISTANT_NAME`: Name prefix for outbound messages (when `ASSISTANT_HAS_OWN_NUMBER=false`)
   - `ASSISTANT_HAS_OWN_NUMBER`: Set `true` if the assistant has its own WhatsApp number (no name prefix needed)

4. Start NanoClaw. The WhatsApp skill starts automatically as a persistent service.

## How It Works

- **Inbound**: Listens for WhatsApp messages, writes them as JSON events to NanoClaw's inbox directory
- **Outbound**: Polls NanoClaw's outbox directory for messages to send via WhatsApp
- **Group sync**: Periodically syncs group metadata (names, participants) to NanoClaw
- **Auth state**: Stored in `store/auth/` — persists across restarts

## JID Patterns

This skill handles all WhatsApp JID types:
- `*@g.us` (groups)
- `*@s.whatsapp.net` (individual chats)
- `*@lid` (linked device IDs, auto-translated to phone JIDs)
