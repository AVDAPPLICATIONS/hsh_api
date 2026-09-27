import { Router, } from 'express';
import whatsappService from '../../services/whatsapp';
import { verifyAdmin } from '../../middleware/auth';

const router = Router();

// GET /api/whatsapp/status
router.get('/status', verifyAdmin, (_req, res) => {
  try {
    const status = whatsappService.getStatus();
    return res.json({ success: true, data: status });
  } catch (err) {
    console.error('Error fetching WA status:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/whatsapp/connect
router.post('/connect', verifyAdmin, async (_req, res) => {
  try {
    whatsappService.connectWhatsApp();
    return res.json({ success: true, message: 'Connecting...' });
  } catch (err) {
    console.error('Error connecting WA:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/whatsapp/pair
router.post('/pair', verifyAdmin, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }
    const code = await whatsappService.getPairingCode(phone);
    return res.json({ success: true, code });
  } catch (err) {
    console.error('Error pairing WA:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// POST /api/whatsapp/disconnect
router.post('/disconnect', verifyAdmin, async (_req, res) => {
  try {
    await whatsappService.disconnectWhatsApp();
    return res.json({ success: true, message: 'Disconnected' });
  } catch (err) {
    console.error('Error disconnecting WA:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/whatsapp/send
router.post('/send', verifyAdmin, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ success: false, message: 'messages array is required' });
    }

    const status = whatsappService.getStatus();
    if (status.status !== 'open') {
      return res.status(400).json({ success: false, message: 'WhatsApp is not connected.' });
    }

    res.json({
      success: true,
      message: `Message sending started for ${messages.length} students in the background.`
    });

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
    console.error('Error in send:', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

export default router;
