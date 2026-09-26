import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../config/db';
import { verifyAdmin, requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';

const router = Router();
const SALT_ROUNDS = 10;

function parseFloors(floors: any): number[] {
  if (!floors) return [];
  if (Array.isArray(floors)) return floors.map(f => parseInt(f, 10)).filter(f => !isNaN(f));
  if (typeof floors === 'string') {
    try {
      const parsed = JSON.parse(floors);
      if (Array.isArray(parsed)) return parsed.map(f => parseInt(f, 10)).filter(f => !isNaN(f));
    } catch (e) {
      return floors.split(',').map(f => parseInt(f.trim(), 10)).filter(f => !isNaN(f));
    }
  }
  return [];
}

function parseSessions(sessions: any): string[] {
  if (!sessions) return ['all'];
  if (Array.isArray(sessions)) return sessions.map(s => String(s).trim()).filter(Boolean);
  if (typeof sessions === 'string') {
    try {
      const parsed = JSON.parse(sessions);
      if (Array.isArray(parsed)) return parsed.map(s => String(s).trim()).filter(Boolean);
    } catch (e) {
      return sessions.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return ['all'];
}

// GET /api/leaders (List all floor leaders)
router.get('/', verifyAdmin, async (_req: Request, res: Response): Promise<any> => {
  try {
    const [leaders]: any = await pool.query(`
      SELECT id, username, name, phone_number, assigned_floors, assigned_sessions, floor_id, is_active, created_at
      FROM floor_leaders
      ORDER BY id DESC
    `);

    const [floors]: any = await pool.query('SELECT floor_id, floor_name FROM floors ORDER BY floor_id ASC');
    const floorMap = new Map();
    floors.forEach((f: any) => floorMap.set(f.floor_id, f.floor_name));

    const [schedules]: any = await pool.query('SELECT session_key, session_name FROM attendance_schedules WHERE is_active = TRUE');
    const sessionMap = new Map();
    schedules.forEach((s: any) => sessionMap.set(s.session_key, s.session_name));

    const [studentCounts]: any = await pool.query(`
      SELECT floor_id, COUNT(*) as count 
      FROM students 
      WHERE is_active = TRUE 
      GROUP BY floor_id
    `);
    const studentCountMap = new Map();
    studentCounts.forEach((s: any) => studentCountMap.set(s.floor_id, s.count));

    const enrichedLeaders = leaders.map((leader: any) => {
      const floorList = parseFloors(leader.assigned_floors || [leader.floor_id]);
      const sessionList = parseSessions(leader.assigned_sessions);

      const floorDetails = floorList.map(fid => ({
        floor_id: fid,
        floor_name: floorMap.get(fid) || `Floor ${fid}`,
        student_count: studentCountMap.get(fid) || 0
      }));

      const sessionDetails = sessionList.map(sKey => ({
        session_key: sKey,
        session_name: sessionMap.get(sKey) || (sKey === 'all' ? 'All Sessions' : sKey)
      }));

      return {
        ...leader,
        assigned_floors: floorList,
        assigned_sessions: sessionList,
        floor_details: floorDetails,
        session_details: sessionDetails
      };
    });

    return res.json({ success: true, leaders: enrichedLeaders });
  } catch (err: any) {
    console.error('Error fetching leaders:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/leaders/assign-student (Assign a student as leader / wing-leader)
router.post('/assign-student', requireAuth, requireRole('platform-admin'), async (req: Request, res: Response): Promise<any> => {
  try {
    const { student_id, role, assigned_floors, assigned_wings, assigned_rooms } = req.body;
    if (!student_id || !role || !assigned_floors) {
      return res.status(400).json({ success: false, message: 'student_id, role (leader/wing-leader), and assigned_floors are required' });
    }

    if (!['leader', 'wing-leader'].includes(role)) {
      return res.status(400).json({ success: false, message: 'role must be "leader" or "wing-leader"' });
    }

    const [students]: any = await pool.query('SELECT id, name FROM students WHERE id = ?', [student_id]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    await pool.query(`
      INSERT INTO student_leadership (student_id, role, assigned_floors, assigned_wings, assigned_rooms, is_active)
      VALUES (?, ?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE 
        role = VALUES(role),
        assigned_floors = VALUES(assigned_floors),
        assigned_wings = VALUES(assigned_wings),
        assigned_rooms = VALUES(assigned_rooms),
        is_active = TRUE
    `, [
      student_id,
      role,
      JSON.stringify(Array.isArray(assigned_floors) ? assigned_floors : [assigned_floors]),
      assigned_wings ? JSON.stringify(assigned_wings) : null,
      assigned_rooms ? JSON.stringify(assigned_rooms) : null
    ]);

    return res.status(201).json({
      success: true,
      message: `Student ${students[0].name} successfully designated as ${role}.`
    });
  } catch (err: any) {
    console.error('Error assigning student leadership:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/leaders/student-leaders (List all student leaders)
router.get('/student-leaders', requireAuth, requireRole('platform-admin', 'leader'), async (_req: Request, res: Response): Promise<any> => {
  try {
    const [rows]: any = await pool.query(`
      SELECT sl.*, s.name AS student_name, s.student_code, s.room_number, s.phone_number
      FROM student_leadership sl
      JOIN students s ON sl.student_id = s.id
      WHERE sl.is_active = TRUE
    `);
    return res.json({ success: true, data: rows });
  } catch (err: any) {
    console.error('Error listing student leaders:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/leaders (Create legacy floor leader)
router.post('/', verifyAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { name, phone_number, username, password, assigned_floors, assigned_sessions, floor_id } = req.body;
    if (!name || !password) {
      return res.status(400).json({ success: false, message: 'Name and password are required' });
    }

    const effectiveUsername = username ? username.trim() : (phone_number ? phone_number.trim() : null);
    if (effectiveUsername) {
      const [existing]: any = await pool.query('SELECT id FROM floor_leaders WHERE username = ?', [effectiveUsername]);
      if (existing.length > 0) {
        return res.status(409).json({ success: false, message: 'Username is already taken' });
      }
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const floorsArray = parseFloors(assigned_floors || [floor_id || 0]);
    const sessionsArray = parseSessions(assigned_sessions || ['all']);

    const [result]: any = await pool.query(
      `INSERT INTO floor_leaders (name, phone_number, username, password_hash, assigned_floors, assigned_sessions, floor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        phone_number || null,
        effectiveUsername,
        password_hash,
        JSON.stringify(floorsArray),
        JSON.stringify(sessionsArray),
        floorsArray[0] || floor_id || 0
      ]
    );

    return res.status(201).json({ success: true, leader_id: result.insertId });
  } catch (err: any) {
    console.error('Error creating leader:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/leaders/:id (Update leader)
router.put('/:id', verifyAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const leaderId = parseInt(req.params.id as string, 10);
    const { name, phone_number, username, password, assigned_floors, assigned_sessions, floor_id, is_active } = req.body;

    const [leaders]: any = await pool.query('SELECT * FROM floor_leaders WHERE id = ?', [leaderId]);
    if (leaders.length === 0) {
      return res.status(404).json({ success: false, message: 'Floor leader not found' });
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (phone_number !== undefined) { updates.push('phone_number = ?'); params.push(phone_number || null); }
    if (username !== undefined) { updates.push('username = ?'); params.push(username ? username.trim() : null); }
    if (password) {
      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      updates.push('password_hash = ?');
      params.push(hash);
    }
    if (assigned_floors !== undefined) {
      const floors = parseFloors(assigned_floors);
      updates.push('assigned_floors = ?');
      params.push(JSON.stringify(floors));
      if (floors.length > 0) {
        updates.push('floor_id = ?');
        params.push(floors[0]);
      }
    }
    if (assigned_sessions !== undefined) {
      const sessions = parseSessions(assigned_sessions);
      updates.push('assigned_sessions = ?');
      params.push(JSON.stringify(sessions));
    }
    if (floor_id !== undefined && assigned_floors === undefined) {
      updates.push('floor_id = ?');
      params.push(floor_id);
    }
    if (is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(is_active);
    }

    if (updates.length > 0) {
      params.push(leaderId);
      await pool.query(`UPDATE floor_leaders SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    return res.json({ success: true, message: 'Leader updated successfully' });
  } catch (err: any) {
    console.error('Error updating leader:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/leaders/:id
router.delete('/:id', verifyAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const leaderId = parseInt(req.params.id as string, 10);
    await pool.query('DELETE FROM floor_leaders WHERE id = ?', [leaderId]);
    return res.json({ success: true, message: 'Leader deleted' });
  } catch (err: any) {
    console.error('Error deleting leader:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
