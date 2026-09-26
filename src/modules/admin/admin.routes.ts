import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../../config/db';
import { verifyAdmin, verifyAdminOrFloorLeader } from '../../middleware/auth';

const router = Router();
router.use(verifyAdminOrFloorLeader);

// GET /api/admin/dashboard
router.get('/dashboard', async (req: Request, res: Response): Promise<any> => {
  try {
    const requestedSessionKey = (req.query.session_key as string) || 'recent';

    let leaderFloors: number[] | null = null;
    if (req.leader) {
      if (Array.isArray(req.leader.assigned_floors) && req.leader.assigned_floors.length > 0) {
        leaderFloors = req.leader.assigned_floors.map((f: any) => parseInt(f, 10)).filter((f: any) => !isNaN(f));
      } else if (req.leader.floor_id !== undefined) {
        leaderFloors = [parseInt(req.leader.floor_id, 10)];
      }
    }

    let total_students = 0;
    if (leaderFloors && leaderFloors.length > 0) {
      const [[countRow]]: any = await pool.query('SELECT COUNT(*) AS count FROM students WHERE is_active = TRUE AND floor_id IN (?)', [leaderFloors]);
      total_students = countRow ? countRow.count : 0;
    } else {
      const [[totalRow]]: any = await pool.query('SELECT COUNT(*) AS total FROM students WHERE is_active = TRUE');
      total_students = totalRow ? totalRow.total : 0;
    }

    const [schedules]: any = await pool.query('SELECT session_key, session_name, icon_name FROM attendance_schedules WHERE is_active = TRUE ORDER BY start_time ASC');

    const [recentSessions]: any = await pool.query(`
      SELECT s.id, s.session_type, s.session_date, s.starts_at, s.ends_at, sch.session_name
      FROM attendance_sessions s
      LEFT JOIN attendance_schedules sch ON s.session_type = sch.session_key
      ORDER BY s.id DESC
      LIMIT 1
    `);

    let recentSessionKey = 'night';
    let recentSessionName = 'Night Attendance';

    if (recentSessions.length > 0) {
      recentSessionKey = recentSessions[0].session_type || 'night';
      recentSessionName = recentSessions[0].session_name || (recentSessionKey.charAt(0).toUpperCase() + recentSessionKey.slice(1) + ' Attendance');
    } else if (schedules.length > 0) {
      recentSessionKey = schedules[0].session_key;
      recentSessionName = schedules[0].session_name;
    }

    let activeFilterKey = requestedSessionKey;
    if (activeFilterKey === 'recent') {
      activeFilterKey = recentSessionKey;
    }

    let targetSessionName = 'All Combined';
    if (activeFilterKey !== 'all') {
      const foundSched = schedules.find((s: any) => s.session_key === activeFilterKey);
      targetSessionName = foundSched ? foundSched.session_name : (activeFilterKey.charAt(0).toUpperCase() + activeFilterKey.slice(1) + ' Attendance');
    }

    let present_today = 0;
    let late_today = 0;
    let sessionCondition = '';
    const sessionParams: any[] = [];

    if (activeFilterKey !== 'all') {
      sessionCondition = 'AND s.session_type = ?';
      sessionParams.push(activeFilterKey);
    }

    if (leaderFloors && leaderFloors.length > 0) {
      const [[presentRow]]: any = await pool.query(`
        SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS present_today 
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.id
        JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
        WHERE s.session_date = CURDATE() AND st.is_active = TRUE AND st.floor_id IN (?) ${sessionCondition}
      `, [leaderFloors, ...sessionParams]);
      present_today = presentRow ? presentRow.present_today : 0;

      const [[lateRow]]: any = await pool.query(`
        SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS late_today 
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.id
        JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
        WHERE s.session_date = CURDATE() AND st.is_active = TRUE AND ar.is_late = TRUE AND st.floor_id IN (?) ${sessionCondition}
      `, [leaderFloors, ...sessionParams]);
      late_today = lateRow ? lateRow.late_today : 0;
    } else {
      const [[presentRow]]: any = await pool.query(`
        SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS present_today 
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.id
        WHERE s.session_date = CURDATE() ${sessionCondition}
      `, sessionParams);
      present_today = presentRow ? presentRow.present_today : 0;

      const [[lateRow]]: any = await pool.query(`
        SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS late_today 
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.id
        WHERE s.session_date = CURDATE() AND ar.is_late = TRUE ${sessionCondition}
      `, sessionParams);
      late_today = lateRow ? lateRow.late_today : 0;
    }

    const absent_today = Math.max(0, total_students - present_today);

    // Floor breakdown
    let floorQuery = `
      SELECT f.floor_id, f.floor_name,
        COUNT(DISTINCT s.id) AS total_students,
        COUNT(DISTINCT CASE WHEN s_att.session_date = CURDATE() ${activeFilterKey !== 'all' ? 'AND s_att.session_type = ?' : ''} THEN TRIM(LEADING '0' FROM ar.bank_code) END) AS present,
        COUNT(DISTINCT CASE WHEN s_att.session_date = CURDATE() ${activeFilterKey !== 'all' ? 'AND s_att.session_type = ?' : ''} AND ar.is_late = TRUE THEN TRIM(LEADING '0' FROM ar.bank_code) END) AS late
      FROM floors f
      LEFT JOIN students s ON f.floor_id = s.floor_id AND s.is_active = TRUE
      LEFT JOIN attendance_records ar ON s.id = ar.student_id OR TRIM(LEADING '0' FROM s.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
      LEFT JOIN attendance_sessions s_att ON ar.session_id = s_att.id
    `;
    const floorParams: any[] = [];
    if (activeFilterKey !== 'all') {
      floorParams.push(activeFilterKey, activeFilterKey);
    }

    if (leaderFloors && leaderFloors.length > 0) {
      floorQuery += ' WHERE f.floor_id IN (?)';
      floorParams.push(leaderFloors);
    }
    floorQuery += ' GROUP BY f.floor_id, f.floor_name ORDER BY f.floor_id ASC';

    const [floors]: any = await pool.query(floorQuery, floorParams);
    const floorBreakdown = floors.map((f: any) => ({
      ...f,
      absent: Math.max(0, f.total_students - f.present)
    }));

    return res.json({
      success: true,
      data: {
        total_students,
        present_today,
        absent_today,
        late_today,
        target_session_key: activeFilterKey,
        target_session_name: targetSessionName,
        available_sessions: schedules,
        floors: floorBreakdown
      }
    });
  } catch (err: any) {
    console.error('Dashboard Error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/admin/reports
router.get('/reports', async (req: Request, res: Response): Promise<any> => {
  try {
    const { timeFilter, floorIdFilter } = req.query;
    let dateConditionSessions = 'WHERE 1=1';
    let dateConditionAttendance = 'WHERE 1=1';
    const sessionCountsParams: any[] = [];
    const attendanceParams: any[] = [];

    if (timeFilter === 'today') {
      dateConditionSessions += ' AND session_date = CURDATE()';
      dateConditionAttendance += ' AND s.session_date = CURDATE()';
    } else if (timeFilter && timeFilter !== 'all') {
      dateConditionSessions += ' AND session_date = ?';
      dateConditionAttendance += ' AND s.session_date = ?';
      sessionCountsParams.push(timeFilter);
      attendanceParams.push(timeFilter);
    }

    let leaderFloors: number[] | null = null;
    if (req.leader) {
      leaderFloors = Array.isArray(req.leader.assigned_floors) && req.leader.assigned_floors.length > 0
        ? req.leader.assigned_floors.map((f: any) => parseInt(f, 10)).filter((f: any) => !isNaN(f))
        : (req.leader.floor_id !== undefined ? [parseInt(req.leader.floor_id, 10)] : []);
    }

    if (floorIdFilter && floorIdFilter !== 'All') {
      dateConditionAttendance += ' AND ar.floor_id = ?';
      attendanceParams.push(floorIdFilter);
    } else if (leaderFloors && leaderFloors.length > 0) {
      dateConditionAttendance += ' AND ar.floor_id IN (?)';
      attendanceParams.push(leaderFloors);
    }

    const [sessionCounts]: any = await pool.query(`
      SELECT session_type, COUNT(id) as total
      FROM attendance_sessions
      ${dateConditionSessions}
      GROUP BY session_type
    `, sessionCountsParams);

    const totals: Record<string, number> = {};
    sessionCounts.forEach((s: any) => {
      if (s.session_type) totals[s.session_type] = s.total;
    });

    const [attendance]: any = await pool.query(`
      SELECT TRIM(LEADING '0' FROM ar.bank_code) as bank_code, s.session_type, COUNT(*) as attended, SUM(ar.is_late) as late_count
      FROM attendance_records ar
      JOIN attendance_sessions s ON ar.session_id = s.id
      ${dateConditionAttendance}
      GROUP BY TRIM(LEADING '0' FROM ar.bank_code), s.session_type
    `, attendanceParams);

    const studentRecords: Record<string, any> = {};
    const lateRecords: Record<string, number> = {};

    attendance.forEach((a: any) => {
      if (!studentRecords[a.bank_code]) studentRecords[a.bank_code] = {};
      if (a.session_type) studentRecords[a.bank_code][a.session_type] = a.attended;
      if (!lateRecords[a.bank_code]) lateRecords[a.bank_code] = 0;
      lateRecords[a.bank_code] += (parseInt(a.late_count, 10) || 0);
    });

    let studentQuery = `
      SELECT s.id, s.student_code, s.name, s.floor_id, s.room_number, s.phone_number, f.floor_name
      FROM students s
      LEFT JOIN floors f ON s.floor_id = f.floor_id
      WHERE s.is_active = TRUE
    `;
    const studentQueryParams: any[] = [];
    if (leaderFloors && leaderFloors.length > 0) {
      studentQuery += ' AND s.floor_id IN (?)';
      studentQueryParams.push(leaderFloors);
    } else if (floorIdFilter && floorIdFilter !== 'All') {
      studentQuery += ' AND s.floor_id = ?';
      studentQueryParams.push(floorIdFilter);
    }
    studentQuery += ' ORDER BY s.floor_id ASC, s.room_number ASC, s.name ASC';

    const [students]: any = await pool.query(studentQuery, studentQueryParams);

    return res.json({ success: true, totals, studentRecords, lateRecords, students });
  } catch (err: any) {
    console.error('Reports Error:', err);
    return res.status(500).json({ success: false, message: err.toString() });
  }
});

// ==========================================
// STAFF MANAGEMENT ENDPOINTS (platform-admin)
// ==========================================
// GET /api/admin/staff (List staff)
router.get('/staff', verifyAdmin, async (_req: Request, res: Response): Promise<any> => {
  try {
    const [staff]: any = await pool.query('SELECT id, username, name, phone_number, role, assigned_categories, is_active, created_at FROM staff_users ORDER BY id DESC');
    return res.json({ success: true, data: staff });
  } catch (err: any) {
    console.error('Error fetching staff:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/admin/staff (Create staff user)
router.post('/staff', verifyAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { username, name, phone_number, password, role, assigned_categories } = req.body;
    if (!username || !name || !password || !role) {
      return res.status(400).json({ success: false, message: 'username, name, password, and role are required' });
    }

    const allowedRoles = ['platform-admin', 'complain-solver', 'laundry-man'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: `role must be one of: ${allowedRoles.join(', ')}` });
    }

    const [existing]: any = await pool.query('SELECT id FROM staff_users WHERE username = ?', [username.trim()]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Username is already taken' });
    }

    const hash = await bcrypt.hash(password, 10);
    const [result]: any = await pool.query(
      `INSERT INTO staff_users (username, name, phone_number, password_hash, role, assigned_categories, is_active)
       VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
      [username.trim(), name.trim(), phone_number || null, hash, role, assigned_categories ? JSON.stringify(assigned_categories) : null]
    );

    return res.status(201).json({
      success: true,
      message: `Staff account (${role}) created successfully`,
      staff_id: result.insertId
    });
  } catch (err: any) {
    console.error('Error creating staff:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/admin/staff/:id
router.delete('/staff/:id', verifyAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const staffId = parseInt(req.params.id as string, 10);
    await pool.query('DELETE FROM staff_users WHERE id = ?', [staffId]);
    return res.json({ success: true, message: 'Staff user deleted successfully' });
  } catch (err: any) {
    console.error('Error deleting staff:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
