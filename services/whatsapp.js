const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

let waSocket = null;
let currentStatus = 'disconnected';
let currentQR = null;

async function connectWhatsApp() {
  if (currentStatus === 'connecting' || currentStatus === 'open') {
    return;
  }

  currentStatus = 'connecting';
  currentQR = null;

  try {
    const authPath = path.join(__dirname, '..', 'config', 'auth_info_baileys');
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
      printQRInTerminal: false,
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
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[WhatsApp] Connection closed due to', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
        currentStatus = 'disconnected';
        waSocket = null;
        
        if (shouldReconnect) {
          setTimeout(() => {
            connectWhatsApp();
          }, 5000);
        } else {
          // Logged out
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

function getStatus() {
  const user = waSocket?.user || null;
  let phone = '';
  let name = '';
  if (user) {
    if (user.id) {
      phone = user.id.split(':')[0].split('@')[0];
    }
    name = user.name || user.notify || '';
  }

  return {
    status: currentStatus,
    qr: currentQR,
    isRegistered: waSocket?.authState?.creds?.registered ?? false,
    user: user ? {
      phone: phone,
      name: name
    } : null
  };
}

async function getPairingCode(phoneNumber) {
  if (!waSocket) {
    await connectWhatsApp();
    // Give it a brief moment to initialize
    await new Promise(r => setTimeout(r, 1000));
  }
  
  if (!waSocket) throw new Error("Socket not initialized");
  if (waSocket.authState.creds.registered) {
    throw new Error("Already registered");
  }

  // Remove any non-digit characters
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  const code = await waSocket.requestPairingCode(cleanNumber);
  currentStatus = 'pairing';
  return code;
}

async function sendMessage(phoneNumber, textMessage) {
  if (!waSocket || currentStatus !== 'open') {
    throw new Error('WhatsApp is not connected.');
  }

  // Format to JID: remove non-digits, ensure country code.
  let cleanNumber = phoneNumber.replace(/\D/g, '');
  // Default to 91 if no country code provided and length is 10
  if (cleanNumber.length === 10) {
    cleanNumber = '91' + cleanNumber;
  }
  const jid = cleanNumber + '@s.whatsapp.net';

  await waSocket.sendMessage(jid, { text: textMessage });
}

async function disconnectWhatsApp() {
  try {
    if (waSocket) {
      await waSocket.logout().catch(() => {});
    }
  } catch (e) {}
  currentStatus = 'disconnected';
  waSocket = null;
  currentQR = null;
  try {
    const authPath = path.join(__dirname, '..', 'config', 'auth_info_baileys');
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Error clearing auth directory:', err);
  }
}

module.exports = {
  connectWhatsApp,
  getStatus,
  getPairingCode,
  sendMessage,
  disconnectWhatsApp
};
