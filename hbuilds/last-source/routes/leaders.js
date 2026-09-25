const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { verifyAdmin, verifyAdminOrFloorLeader } = require('../middleware/auth');

const SALT_ROUNDS = 10;

// Helper to safely parse assigned floors
function parseFloors(floors) {
  if (!floors) return [];
  if (Array.isArray(floors)) return floors.map(f => parseInt(f, 10)).filter(f => !isNaN(f));
  if (typeof floors === 'string') {
    try {
      const parsed = JSON.parse(floors);
      if (Array.isArray(parsed)) return parsed.map(f => parseInt(f, 10)).filter(f => !isNaN(f));
    } catch(e) {
      return floors.split(',').map(f => parseInt(f.trim(), 10)).filter(f => !isNaN(f));
    }
  }
  return [];
}

// Helper to safely parse assigned sessions
function parseSessions(sessions) {
  if (!sessions) return ['all'];
  if (Array.isArray(sessions)) return sessions.map(s => String(s).trim()).filter(Boolean);
  if (typeof sessions === 'string') {
    try {
      const parsed = JSON.parse(sessions);
      if (Array.isArray(parsed)) return parsed.map(s => String(s).trim()).filter(Boolean);
    } catch(e) {
      return sessions.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return ['all'];
}

// ------------------------------------------------------------
// GET /api/leaders
// List all floor leaders with their assigned floors and stats (Admin only)
// ------------------------------------------------------------
router.get('/', verifyAdmin, async (req, res) => {
  try {
    const [leaders] = await pool.query(`
      SELECT id, username, name, phone_number, assigned_floors, assigned_sessions, floor_id, is_active, created_at
      FROM floor_leaders
      ORDER BY id DESC
    `);

    // Fetch all floors for mapping
    const [floors] = await pool.query('SELECT floor_id, floor_name FROM floors ORDER BY floor_id ASC');
    const floorMap = new Map();
    floors.forEach(f => floorMap.set(f.floor_id, f.floor_name));

    // Fetch all sessions for mapping
    const [schedules] = await pool.query('SELECT session_key, session_name FROM attendance_schedules WHERE is_active = TRUE');
    const sessionMap = new Map();
    schedules.forEach(s => sessionMap.set(s.session_key, s.session_name));

    // Fetch student count per floor
    const [studentCounts] = await pool.query(`
      SELECT floor_id, COUNT(*) as count 
      FROM students 
      WHERE is_active = TRUE 
      GROUP BY floor_id
    `);
    const studentCountMap = new Map();
    studentCounts.forEach(s => studentCountMap.set(s.floor_id, s.count));

    const enrichedLeaders = leaders.map(leader => {
      const floorList = parseFloors(leader.assigned_floors || [leader.floor_id]);
      const sessionList = parseSessions(leader.assigned_sessions);
      
      const floorDetails = floorList.map(fid => ({
        floor_id: fid,
        floor_name: floorMap.get(fid) || `Floor ${fid}`,
        student_count: studentCountMap.get(fid) || 0
      }));

      const sessionDetails = sessionList.includes('all')
        ? [{ session_key: 'all', session_name: 'All Sessions' }]
        : sessionList.map(skey => ({
            session_key: skey,
            session_name: sessionMap.get(skey) || (skey.charAt(0).toUpperCase() + skey.slice(1) + ' Attendance')
          }));

      const totalAssignedStudents = floorDetails.reduce((sum, f) => sum + f.student_count, 0);

      return {
        id: leader.id,
        username: leader.username || `leader_${leader.id}`,
        name: leader.name,
        phone_number: leader.phone_number,
        assigned_floors: floorList,
        assigned_sessions: sessionList,
        floor_details: floorDetails,
        session_details: sessionDetails,
        total_students: totalAssignedStudents,
        is_active: leader.is_active === 1 || leader.is_active === true,
        created_at: leader.created_at
      };
    });

    return res.json({ success: true, data: enrichedLeaders });
  } catch (err) {
    console.error('Error fetching leaders:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// ------------------------------------------------------------
// POST /api/leaders
// Create a new floor leader (Admin only)
// ------------------------------------------------------------
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const { name, username, password, assigned_floors, assigned_sessions, phone_number } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ success: false, message: 'Name, Username ID, and Password are required' });
    }

    const trimmedUsername = String(username).trim();
    const trimmedName = String(name).trim();

    if (!trimmedUsername) {
      return res.status(400).json({ success: false, message: 'Valid Username ID is required' });
    }

    const floors = parseFloors(assigned_floors);
    if (floors.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one assigned floor' });
    }

    const sessions = parseSessions(assigned_sessions);

    // Check if username already exists in floor_leaders
    const [existing] = await pool.query(
      'SELECT id FROM floor_leaders WHERE LOWER(username) = LOWER(?) OR phone_number = ?',
      [trimmedUsername, phone_number || trimmedUsername]
    );

    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'A leader with this Username ID or Phone Number already exists' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const primaryFloor = floors[0];
    const floorsJson = JSON.stringify(floors);
    const sessionsJson = JSON.stringify(sessions);

    const [result] = await pool.query(`
      INSERT INTO floor_leaders (username, name, phone_number, password_hash, assigned_floors, assigned_sessions, floor_id, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)
    `, [trimmedUsername, trimmedName, phone_number || null, passwordHash, floorsJson, sessionsJson, primaryFloor]);

    return res.status(201).json({
      success: true,
      data: {
        id: result.insertId,
        username: trimmedUsername,
        name: trimmedName,
        phone_number: phone_number || null,
        assigned_floors: floors,
        assigned_sessions: sessions,
        is_active: true
      },
      message: 'Floor Leader created successfully'
    });
  } catch (err) {
    console.error('Error creating floor leader:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// ------------------------------------------------------------
// PUT /api/leaders/:id
// Update an existing floor leader (Admin only)
// ------------------------------------------------------------
router.put('/:id', verifyAdmin, async (req, res) => {
  try {
    const leaderId = req.params.id;
    const { name, username, password, assigned_floors, assigned_sessions, phone_number, is_active } = req.body;

    const [existing] = await pool.query('SELECT * FROM floor_leaders WHERE id = ?', [leaderId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Floor leader not found' });
    }

    const leader = existing[0];
    const updatedName = name ? String(name).trim() : leader.name;
    const updatedUsername = username ? String(username).trim() : (leader.username || `leader_${leader.id}`);
    const updatedPhone = phone_number !== undefined ? phone_number : leader.phone_number;
    const updatedActive = is_active !== undefined ? (is_active ? 1 : 0) : leader.is_active;

    let updatedFloors = leader.assigned_floors;
    let primaryFloor = leader.floor_id;
    if (assigned_floors !== undefined) {
      const parsed = parseFloors(assigned_floors);
      if (parsed.length === 0) {
        return res.status(400).json({ success: false, message: 'Please select at least one assigned floor' });
      }
      updatedFloors = JSON.stringify(parsed);
      primaryFloor = parsed[0];
    }

    let updatedSessions = leader.assigned_sessions;
    if (assigned_sessions !== undefined) {
      const parsedSess = parseSessions(assigned_sessions);
      updatedSessions = JSON.stringify(parsedSess);
    }

    // Check if username is being changed to something already taken
    if (username && String(username).trim().toLowerCase() !== String(leader.username || '').toLowerCase()) {
      const [duplicate] = await pool.query(
        'SELECT id FROM floor_leaders WHERE LOWER(username) = LOWER(?) AND id != ?',
        [String(username).trim(), leaderId]
      );
      if (duplicate.length > 0) {
        return res.status(409).json({ success: false, message: 'Username ID is already taken by another leader' });
      }
    }

    let passwordHash = leader.password_hash;
    if (password && String(password).trim()) {
      passwordHash = await bcrypt.hash(String(password).trim(), SALT_ROUNDS);
    }

    await pool.query(`
      UPDATE floor_leaders
      SET username = ?, name = ?, phone_number = ?, password_hash = ?, assigned_floors = ?, assigned_sessions = ?, floor_id = ?, is_active = ?
      WHERE id = ?
    `, [updatedUsername, updatedName, updatedPhone, passwordHash, updatedFloors, updatedSessions, primaryFloor, updatedActive, leaderId]);

    return res.json({
      success: true,
      message: 'Floor leader updated successfully',
      data: {
        id: leaderId,
        username: updatedUsername,
        name: updatedName,
        assigned_floors: parseFloors(updatedFloors),
        assigned_sessions: parseSessions(updatedSessions),
        is_active: updatedActive === 1
      }
    });
  } catch (err) {
    console.error('Error updating floor leader:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// ------------------------------------------------------------
// DELETE /api/leaders/:id
// Delete a floor leader (Admin only)
// ------------------------------------------------------------
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const leaderId = req.params.id;
    const [existing] = await pool.query('SELECT id FROM floor_leaders WHERE id = ?', [leaderId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Floor leader not found' });
    }

    await pool.query('DELETE FROM floor_leaders WHERE id = ?', [leaderId]);
    return res.json({ success: true, message: 'Floor leader deleted successfully' });
  } catch (err) {
    console.error('Error deleting floor leader:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

module.exports = router;
