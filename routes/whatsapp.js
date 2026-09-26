const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsapp');
const { verifyAdmin } = require('../middleware/auth');

// ------------------------------------------------------------
// GET /api/whatsapp/status
// ------------------------------------------------------------
router.get('/status', verifyAdmin, (req, res) => {
  try {
    const status = whatsappService.getStatus();
    return res.json({ success: true, data: status });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/whatsapp/connect
// ------------------------------------------------------------
router.post('/connect', verifyAdmin, async (req, res) => {
  try {
    whatsappService.connectWhatsApp(); // non-blocking
    return res.json({ success: true, message: 'Connecting...' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/whatsapp/pair
// ------------------------------------------------------------
router.post('/pair', verifyAdmin, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }
    const code = await whatsappService.getPairingCode(phone);
    return res.json({ success: true, code });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/whatsapp/disconnect
// ------------------------------------------------------------
router.post('/disconnect', verifyAdmin, async (req, res) => {
  try {
    await whatsappService.disconnectWhatsApp();
    return res.json({ success: true, message: 'Disconnected' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/whatsapp/send
// ------------------------------------------------------------
router.post('/send', verifyAdmin, async (req, res) => {
  try {
    const { messages } = req.body; // array of { phone, text }
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ success: false, message: 'messages array is required' });
    }

    const status = whatsappService.getStatus();
    if (status.status !== 'open') {
      return res.status(400).json({ success: false, message: 'WhatsApp is not connected.' });
    }

    // Respond immediately to avoid Hostinger 60-second timeouts
    res.json({ 
      success: true, 
      message: `Message sending started for ${messages.length} students in the background. Please wait a few minutes for all messages to be delivered.` 
    });

    // Process asynchronously
    (async () => {
      let successCount = 0;
      let failCount = 0;

      for (const msg of messages) {
        if (!msg.phone || !msg.text) continue;
        try {
          await whatsappService.sendMessage(msg.phone, msg.text);
          successCount++;
        } catch (e) {
          console.error('Failed to send to', msg.phone, e);
          failCount++;
        }
      }
      console.log(`Finished sending WhatsApp bulk messages. Success: ${successCount}, Fail: ${failCount}`);
    })();

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

module.exports = router;
