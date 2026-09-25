const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyAdmin, verifyAdminOrFloorLeader } = require('../middleware/auth');

// ------------------------------------------------------------
// GET /api/floors
// ------------------------------------------------------------
router.get('/', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const [floors] = await pool.query('SELECT floor_id, floor_name AS name FROM floors ORDER BY floor_id ASC');
    return res.json({ success: true, data: floors });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/floors
// ------------------------------------------------------------
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const { floor_id, floor_name, esp32_ble_service_uuid, has_wifi } = req.body;
    
    if (floor_id === undefined || !floor_name || !esp32_ble_service_uuid) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    await pool.query(
      'INSERT INTO floors (floor_id, floor_name, esp32_ble_service_uuid, has_wifi) VALUES (?, ?, ?, ?)', 
      [floor_id, floor_name, esp32_ble_service_uuid, has_wifi || false]
    );
    return res.status(201).json({ success: true, message: 'Floor added successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
