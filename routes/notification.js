const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const admin = require('../config/firebase');
const { verifyAdminOrFloorLeader } = require('../middleware/auth');

// ------------------------------------------------------------
// POST /api/notification/send
// ------------------------------------------------------------
router.post('/send', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const { title, body, target, value } = req.body;

    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Missing title or body' });
    }

    let query = '';
    let queryParams = [];

    if (target === 'all') {
      query = 'SELECT fcm_token FROM students WHERE fcm_token IS NOT NULL';
    } else if (target === 'phone') {
      if (!value) {
        return res.status(400).json({ success: false, message: 'Missing phone number for target phone' });
      }
      query = 'SELECT fcm_token FROM students WHERE phone_number = ? AND fcm_token IS NOT NULL';
      queryParams.push(value);
    } else if (target === 'room') {
      if (!value) {
        return res.status(400).json({ success: false, message: 'Missing room number for target room' });
      }
      query = 'SELECT fcm_token FROM students WHERE room_number = ? AND fcm_token IS NOT NULL';
      queryParams.push(value);
    } else if (target === 'bank_code') {
      if (!value) {
        return res.status(400).json({ success: false, message: 'Missing bank code for target bank_code' });
      }
      // Bank codes usually ignore leading zeros when comparing
      query = `SELECT fcm_token FROM students WHERE TRIM(LEADING '0' FROM student_code) = TRIM(LEADING '0' FROM ?) AND fcm_token IS NOT NULL`;
      queryParams.push(value);
    } else {
      return res.status(400).json({ success: false, message: 'Invalid target specified' });
    }

    const [rows] = await pool.query(query, queryParams);
    const tokens = rows.map(r => r.fcm_token).filter(t => t);

    if (tokens.length === 0) {
      return res.status(404).json({ success: false, message: 'No registered devices found for the specified target' });
    }

    const message = {
      notification: { title, body },
      tokens: tokens,
    };

    const response = await admin.messaging().sendMulticast(message);
    
    return res.json({
      success: true,
      message: `Successfully sent ${response.successCount} messages. Failed: ${response.failureCount}`,
      details: {
        successCount: response.successCount,
        failureCount: response.failureCount
      }
    });

  } catch (err) {
    console.error('Error sending custom push notification:', err);
    return res.status(500).json({ success: false, message: 'Server error while sending notification' });
  }
});

module.exports = router;
