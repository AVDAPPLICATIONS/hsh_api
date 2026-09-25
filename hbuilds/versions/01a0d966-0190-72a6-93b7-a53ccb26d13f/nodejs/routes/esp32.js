const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// ------------------------------------------------------------
// POST /api/esp32/heartbeat
// ------------------------------------------------------------
router.post('/heartbeat', async (req, res) => {
  try {
    const { device_name } = req.body;
    if (!device_name) {
      return res.status(400).json({ success: false, message: 'Missing device_name' });
    }

    // Try to find the floor assigned to this ESP-32
    const [rows] = await pool.query('SELECT floor_id FROM floors WHERE device_name = ?', [device_name]);
    
    let floorId = null;
    if (rows.length > 0) {
      floorId = rows[0].floor_id;
      // Update last seen
      await pool.query('UPDATE floors SET last_seen = NOW() WHERE floor_id = ?', [floorId]);
    }

    return res.json({ success: true, floor_id: floorId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/esp32/active-tokens
// Called by the Ground Floor ESP32 (Master) every 30 seconds.
// Returns the currently active tokens for all floors so it can 
// broadcast them via ESP-NOW to the upper floors.
// ------------------------------------------------------------
router.get('/active-tokens', async (req, res) => {
  try {
    // Only return tokens if they are NOT NULL (which means attendance is active)
    const [rows] = await pool.query(
      'SELECT floor_id, current_token FROM floors WHERE current_token IS NOT NULL'
    );
    
    return res.json({
      success: true,
      active: rows.length > 0,
      tokens: rows
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
