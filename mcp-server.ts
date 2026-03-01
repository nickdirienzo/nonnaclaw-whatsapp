/**
 * WhatsApp MCP Server
 *
 * Stdio MCP server wrapping Baileys. Spawned by the host-side MCP bridge,
 * which connects as a client and exposes this server to containers via HTTP.
 *
 * Tools:
 * - send_message: Send a WhatsApp message
 * - list_new_messages: Get messages since a timestamp (used by bridge polling)
 * - list_chats: List available chats/groups
 * - search_contacts: Search contacts by name/number
 */
import fs from 'fs';
import path from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

// --- Configuration ---

const STORE_DIR = process.env.NANOCLAW_STORE_DIR || path.resolve(import.meta.dirname, '../../store');
const AUTH_DIR = path.join(STORE_DIR, 'auth');
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Assistant';
const ASSISTANT_HAS_OWN_NUMBER = process.env.ASSISTANT_HAS_OWN_NUMBER === 'true';

const logger = pino({
  level: process.env.LOG_LEVEL || 'warn',
  transport: { target: 'pino/file', options: { destination: 2 } }, // stderr only
});

// --- In-memory message buffer ---

interface BufferedMessage {
  chat_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  message_id?: string;
  is_group: boolean;
  is_from_me: boolean;
}

const MESSAGE_BUFFER_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const messageBuffer: BufferedMessage[] = [];

function pruneBuffer(): void {
  const cutoff = Date.now() - MESSAGE_BUFFER_MAX_AGE_MS;
  while (messageBuffer.length > 0) {
    const oldest = new Date(messageBuffer[0].timestamp).getTime();
    if (oldest < cutoff) {
      messageBuffer.shift();
    } else {
      break;
    }
  }
}

// --- LID translation ---

const lidToPhoneMap: Record<string, string> = {};

async function translateJid(sock: WASocket, jid: string): Promise<string> {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = jid.split('@')[0].split(':')[0];

  const cached = lidToPhoneMap[lidUser];
  if (cached) return cached;

  try {
    const pn = await (sock as any).signalRepository?.lidMapping?.getPNForLID(jid);
    if (pn) {
      const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
      lidToPhoneMap[lidUser] = phoneJid;
      return phoneJid;
    }
  } catch (err) {
    logger.debug({ err, jid }, 'Failed to resolve LID');
  }

  return jid;
}

// --- WhatsApp connection ---

let sock: WASocket | null = null;
let connected = false;

async function connectWhatsApp(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
    logger.warn({ err }, 'Failed to fetch latest WA Web version');
    return { version: undefined };
  });

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger as any),
    },
    printQRInTerminal: false,
    logger: logger as any,
    browser: Browsers.macOS('Chrome'),
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.error('WhatsApp authentication required. Run: npm run auth');
      process.exit(1);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      connected = false;

      if (reason === DisconnectReason.loggedOut) {
        logger.error('Logged out. Re-run auth script.');
        process.exit(1);
      }

      // Exit cleanly — bridge will detect the process exit and restart
      logger.info({ reason }, 'Connection closed, exiting for restart');
      process.exit(0);
    } else if (connection === 'open') {
      connected = true;
      logger.info('Connected to WhatsApp');

      sock!.sendPresenceUpdate('available').catch(() => {});

      // Build LID→phone mapping for self
      if (sock!.user) {
        const phoneUser = sock!.user.id.split(':')[0];
        const lidUser = sock!.user.lid?.split(':')[0];
        if (lidUser && phoneUser) {
          lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
        }
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!sock) return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === 'status@broadcast') continue;

      const chatJid = await translateJid(sock, rawJid);
      const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();

      const content =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

      if (!content) continue;

      const sender = msg.key.participant || msg.key.remoteJid || '';
      const senderName = msg.pushName || sender.split('@')[0];
      const fromMe = msg.key.fromMe || false;
      const isGroup = chatJid.endsWith('@g.us');

      const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
        ? fromMe
        : content.startsWith(`${ASSISTANT_NAME}:`);

      // Skip bot's own messages
      if (isBotMessage) continue;

      messageBuffer.push({
        chat_id: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        message_id: msg.key.id || undefined,
        is_group: isGroup,
        is_from_me: fromMe,
      });

      pruneBuffer();
    }
  });
}

// --- MCP Server ---

const server = new Server(
  { name: 'whatsapp-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a WhatsApp message to a chat',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: 'WhatsApp JID (e.g., 1234567890@s.whatsapp.net or 1234567890@g.us)',
          },
          text: {
            type: 'string',
            description: 'Message text to send',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'list_new_messages',
      description: 'Get new messages received since a given timestamp. Used for inbound polling.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. Returns messages after this time. Omit for all buffered messages.',
          },
        },
      },
    },
    {
      name: 'list_chats',
      description: 'List available WhatsApp chats and groups',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'search_contacts',
      description: 'Search WhatsApp contacts by name or number',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Search query (name or phone number)',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!sock || !connected) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'WhatsApp not connected' }) }],
      isError: true,
    };
  }

  switch (name) {
    case 'send_message': {
      const chatId = args?.chat_id as string;
      const text = args?.text as string;
      if (!chatId || !text) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'chat_id and text required' }) }],
          isError: true,
        };
      }

      const outText = ASSISTANT_HAS_OWN_NUMBER
        ? text
        : `${ASSISTANT_NAME}: ${text}`;

      await sock.sendMessage(chatId, { text: outText });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, chat_id: chatId }) }],
      };
    }

    case 'list_new_messages': {
      pruneBuffer();
      const since = args?.since as string | undefined;

      let messages = messageBuffer;
      if (since) {
        const sinceTime = new Date(since).getTime();
        messages = messageBuffer.filter(
          (m) => new Date(m.timestamp).getTime() > sinceTime,
        );
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(messages) }],
      };
    }

    case 'list_chats': {
      try {
        const groups = await sock.groupFetchAllParticipating();
        const chats = Object.entries(groups).map(([jid, meta]) => ({
          chat_id: jid,
          name: meta.subject,
          is_group: true,
          participant_count: meta.participants?.length || 0,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(chats) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to list chats', details: String(err) }) }],
          isError: true,
        };
      }
    }

    case 'search_contacts': {
      const query = (args?.query as string || '').toLowerCase();
      // Search through known groups
      try {
        const groups = await sock.groupFetchAllParticipating();
        const matches = Object.entries(groups)
          .filter(([jid, meta]) =>
            meta.subject?.toLowerCase().includes(query) ||
            jid.includes(query),
          )
          .map(([jid, meta]) => ({
            chat_id: jid,
            name: meta.subject,
            is_group: true,
          }));
        return {
          content: [{ type: 'text', text: JSON.stringify(matches) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Search failed', details: String(err) }) }],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
  }
});

// --- Startup ---

async function main(): Promise<void> {
  // Connect to WhatsApp first
  await connectWhatsApp();

  // Start MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('WhatsApp MCP server running on stdio');
}

// Graceful shutdown
const shutdown = () => {
  logger.info('Shutting down...');
  if (sock) sock.end(undefined);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  logger.error({ err }, 'Failed to start WhatsApp MCP server');
  process.exit(1);
});
