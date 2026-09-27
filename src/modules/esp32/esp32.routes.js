import { Router, } from 'express';
import pool from '../../config/db';

const router = Router();

// POST /api/esp32/heartbeat
router.post('/heartbeat', async (req, res) => {
  try {
    const { device_name } = req.body;
    if (!device_name) {
      return res.status(400).json({ success: false, message: 'Missing device_name' });
    }

    const [rows] = await pool.query('SELECT floor_id FROM floors WHERE device_name = ?', [device_name]);
    let floorId = null;
    if (rows.length > 0) {
      floorId = rows[0].floor_id;
      await pool.query('UPDATE floors SET last_seen = NOW() WHERE floor_id = ?', [floorId]);
    }

    return res.json({ success: true, floor_id: floorId });
  } catch (err) {
    console.error('Error in esp32 heartbeat:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/esp32/active-tokens
router.get('/active-tokens', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT floor_id, current_token FROM floors WHERE current_token IS NOT NULL'
    );

    return res.json({
      success: true,
      active: rows.length > 0,
      tokens: rows
    });
  } catch (err) {
    console.error('Error in active-tokens:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
