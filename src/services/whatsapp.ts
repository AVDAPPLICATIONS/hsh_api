import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';

let waSocket: WASocket | null = null;
let currentStatus = 'disconnected';
let currentQR: string | null = null;

export async function connectWhatsApp(): Promise<void> {
  if (currentStatus === 'connecting' || currentStatus === 'open') {
    return;
  }

  currentStatus = 'connecting';
  currentQR = null;

  try {
    const authPath = path.resolve('src/config/auth_info_baileys');
    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`[WhatsApp] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        currentStatus = 'qr';
        console.log('[WhatsApp] QR Code received');
      }

      if (connection === 'close') {
        currentQR = null;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('[WhatsApp] Connection closed:', lastDisconnect?.error, 'reconnecting:', shouldReconnect);
        currentStatus = 'disconnected';
        waSocket = null;

        if (shouldReconnect) {
          setTimeout(() => {
            connectWhatsApp();
          }, 5000);
        } else {
          console.log('[WhatsApp] Logged out. Delete auth folder to rescan.');
          if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
          }
        }
      } else if (connection === 'open') {
        console.log('[WhatsApp] Connection opened');
        currentStatus = 'open';
        currentQR = null;
      }
    });

    waSocket = sock;
  } catch (err) {
    console.error('[WhatsApp] Error connecting', err);
    currentStatus = 'disconnected';
    waSocket = null;
  }
}

export function getStatus() {
  const user = waSocket?.user || null;
  let phone = '';
  let name = '';
  if (user) {
    if (user.id) {
      phone = user.id.split(':')[0].split('@')[0];
    }
    name = user.name || (user as any).notify || '';
  }

  return {
    status: currentStatus,
    qr: currentQR,
    isRegistered: (waSocket as any)?.authState?.creds?.registered ?? false,
    user: user ? { phone, name } : null
  };
}

export async function getPairingCode(phoneNumber: string): Promise<string> {
  if (!waSocket) {
    await connectWhatsApp();
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!waSocket) throw new Error('Socket not initialized');
  if ((waSocket as any).authState?.creds?.registered) {
    throw new Error('Already registered');
  }

  const cleanNumber = phoneNumber.replace(/\D/g, '');
  const code = await waSocket.requestPairingCode(cleanNumber);
  currentStatus = 'pairing';
  return code;
}

export async function sendMessage(phoneNumber: string, textMessage: string): Promise<void> {
  if (!waSocket || currentStatus !== 'open') {
    throw new Error('WhatsApp is not connected.');
  }

  let cleanNumber = phoneNumber.replace(/\D/g, '');
  if (cleanNumber.length === 10) {
    cleanNumber = '91' + cleanNumber;
  }
  const jid = cleanNumber + '@s.whatsapp.net';

  await waSocket.sendMessage(jid, { text: textMessage });
}

export async function disconnectWhatsApp(): Promise<void> {
  try {
    if (waSocket) {
      await waSocket.logout().catch(() => {});
    }
  } catch (e) {}
  currentStatus = 'disconnected';
  waSocket = null;
  currentQR = null;
  try {
    const authPath = path.resolve('src/config/auth_info_baileys');
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Error clearing auth directory:', err);
  }
}

export default {
  connectWhatsApp,
  getStatus,
  getPairingCode,
  sendMessage,
  disconnectWhatsApp
};
