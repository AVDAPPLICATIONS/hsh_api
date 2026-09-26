const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { verifyAdmin, verifyAdminOrFloorLeader } = require('../middleware/auth');

const CODE_EXPIRY_MIN = parseInt(process.env.REBIND_CODE_EXPIRY_MINUTES || '10', 10);

router.use(verifyAdminOrFloorLeader);

// ------------------------------------------------------------
// GET /api/admin/dashboard
// ------------------------------------------------------------
router.get('/dashboard', async (req, res) => {
  try {
    const requestedSessionKey = req.query.session_key || 'recent';

    // Determine if requester is a floor leader
    let leaderFloors = null;
    if (req.leader) {
      if (Array.isArray(req.leader.assigned_floors) && req.leader.assigned_floors.length > 0) {
        leaderFloors = req.leader.assigned_floors.map(f => parseInt(f, 10)).filter(f => !isNaN(f));
      } else if (req.leader.floor_id !== undefined) {
        leaderFloors = [parseInt(req.leader.floor_id, 10)];
      }
    }

    // 1. Total Active Students
    let total_students = 0;
    if (leaderFloors && leaderFloors.length > 0) {
      const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM students WHERE is_active = TRUE AND floor_id IN (?)', [leaderFloors]);
      total_students = count;
    } else {
      const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM students WHERE is_active = TRUE');
      total_students = total;
    }

    // 2. Fetch all configured dynamic sessions
    const [schedules] = await pool.query('SELECT session_key, session_name, icon_name FROM attendance_schedules WHERE is_active = TRUE ORDER BY start_time ASC');
    
    // 3. Find the most recent session taken/created (with records or latest session id)
    const [recentSessions] = await pool.query(`
      SELECT s.id, s.session_type, s.session_date, s.starts_at, s.ends_at, sch.session_name
      FROM attendance_sessions s
      LEFT JOIN attendance_schedules sch ON s.session_type = sch.session_key
      ORDER BY s.id DESC
      LIMIT 1
    `);

    let recentSessionKey = 'night';
    let recentSessionName = 'Night Attendance';
    let recentSessionDate = new Date().toISOString().slice(0, 10);

    if (recentSessions.length > 0) {
      recentSessionKey = recentSessions[0].session_type || 'night';
      recentSessionName = recentSessions[0].session_name || (recentSessionKey.charAt(0).toUpperCase() + recentSessionKey.slice(1) + ' Attendance');
      recentSessionDate = recentSessions[0].session_date;
    } else if (schedules.length > 0) {
      recentSessionKey = schedules[0].session_key;
      recentSessionName = schedules[0].session_name;
    }

    // Determine target session to display
    let activeFilterKey = requestedSessionKey;
    if (activeFilterKey === 'recent') {
      activeFilterKey = recentSessionKey;
    }

    let targetSessionName = 'All Combined';
    if (activeFilterKey !== 'all') {
      const foundSched = schedules.find(s => s.session_key === activeFilterKey);
      targetSessionName = foundSched ? foundSched.session_name : (activeFilterKey.charAt(0).toUpperCase() + activeFilterKey.slice(1) + ' Attendance');
    }

    // 4. Compute Present and Late for the target session
    let present_today = 0;
    let late_today = 0;

    let sessionCondition = '';
    const sessionParams = [];

    if (activeFilterKey !== 'all') {
      sessionCondition = 'AND s.session_type = ?';
      sessionParams.push(activeFilterKey);
    }

    if (leaderFloors && leaderFloors.length > 0) {
      const [[presentRow]] = await pool.query(`
        SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS present_today 
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.id
        JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
        WHERE s.session_date = CURDATE() AND st.is_active = TRUE AND st.floor_id IN (?) ${sessionCondition}
      `, [leaderFloors, ...sessionParams]);
      present_today = presentRow ? presentRow.present_today : 0;

      const [[lateRow]] = await pool.query(`
        SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS late_today 
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.id
        JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
        WHERE s.session_date = CURDATE() AND ar.is_late = TRUE AND st.is_active = TRUE AND st.floor_id IN (?) ${sessionCondition}
      `, [leaderFloors, ...sessionParams]);
      late_today = lateRow ? parseInt(lateRow.late_today || 0, 10) : 0;
    } else {
      const [[presentRow]] = await pool.query(`
        SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS present_today 
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.id
        JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
        WHERE s.session_date = CURDATE() AND st.is_active = TRUE ${sessionCondition}
      `, sessionParams);
      present_today = presentRow ? presentRow.present_today : 0;

      const [[lateRow]] = await pool.query(`
        SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS late_today 
        FROM attendance_records ar
        JOIN attendance_sessions s ON ar.session_id = s.id
        JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
        WHERE s.session_date = CURDATE() AND ar.is_late = TRUE AND st.is_active = TRUE ${sessionCondition}
      `, sessionParams);
      late_today = lateRow ? parseInt(lateRow.late_today || 0, 10) : 0;
    }

    const absent_today = Math.max(0, total_students - present_today);

    // 5. Compute summary for each available session today
    let allSessionsQuery = `
      SELECT s.session_type, COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) as present_count
      FROM attendance_sessions s
      LEFT JOIN attendance_records ar ON s.id = ar.session_id
      LEFT JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
      WHERE s.session_date = CURDATE() AND (st.is_active = TRUE OR ar.bank_code IS NULL)
    `;
    const allSessionsParams = [];
    if (leaderFloors && leaderFloors.length > 0) {
      allSessionsQuery += ' AND (st.floor_id IN (?) OR ar.bank_code IS NULL)';
      allSessionsParams.push(leaderFloors);
    }
    allSessionsQuery += ' GROUP BY s.session_type';

    const [allSessionsToday] = await pool.query(allSessionsQuery, allSessionsParams);

    const sessionCountsMap = {};
    for (const row of allSessionsToday) {
      sessionCountsMap[row.session_type] = row.present_count;
    }

    const available_sessions = [
      {
        session_key: 'recent',
        session_name: `Recent (${recentSessionName})`,
        actual_key: recentSessionKey,
        present_today: sessionCountsMap[recentSessionKey] || 0
      },
      ...schedules.map(s => ({
        session_key: s.session_key,
        session_name: s.session_name,
        actual_key: s.session_key,
        present_today: sessionCountsMap[s.session_key] || 0
      })),
      {
        session_key: 'all',
        session_name: 'All Sessions Combined',
        actual_key: 'all',
        present_today: present_today
      }
    ];

    // 6. Weekly Stats for the target session
    let weeklySessionCondition = '';
    const weeklySessionParams = [];
    if (activeFilterKey !== 'all') {
      weeklySessionCondition = 'AND s.session_type = ?';
      weeklySessionParams.push(activeFilterKey);
    }

    let weeklyStatsQuery = `
      SELECT 
        s.session_date AS date, 
        COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS present,
        SUM(CASE WHEN ar.is_late = TRUE THEN 1 ELSE 0 END) AS late
      FROM attendance_sessions s
      LEFT JOIN attendance_records ar ON s.id = ar.session_id
      LEFT JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
      WHERE s.session_date >= CURDATE() - INTERVAL 6 DAY AND (st.is_active = TRUE OR ar.bank_code IS NULL)
    `;
    const weeklyStatsParams = [];
    if (leaderFloors && leaderFloors.length > 0) {
      weeklyStatsQuery += ' AND (st.floor_id IN (?) OR ar.bank_code IS NULL)';
      weeklyStatsParams.push(leaderFloors);
    }
    weeklyStatsQuery += ` ${weeklySessionCondition} GROUP BY s.session_date ORDER BY s.session_date ASC`;
    weeklyStatsParams.push(...weeklySessionParams);

    const [weeklyStatsRows] = await pool.query(weeklyStatsQuery, weeklyStatsParams);

    const weekly_stats = weeklyStatsRows.map(row => {
      const dateObj = new Date(row.date);
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      return {
        date: `${year}-${month}-${day}`,
        present: row.present,
        late: parseInt(row.late || 0, 10)
      };
    });

    // 7. Floor Status for the selected session
    let floorsQuery = 'SELECT floor_id, floor_name FROM floors';
    const floorsParams = [];
    if (leaderFloors && leaderFloors.length > 0) {
      floorsQuery += ' WHERE floor_id IN (?)';
      floorsParams.push(leaderFloors);
    }
    floorsQuery += ' ORDER BY floor_id ASC';
    const [floors] = await pool.query(floorsQuery, floorsParams);
    const floor_status = [];

    // Find the latest session for the activeFilterKey
    let targetSessionQuery = 'SELECT id, starts_at, ends_at FROM attendance_sessions WHERE session_date = CURDATE()';
    const targetSessionQueryParams = [];
    if (activeFilterKey !== 'all') {
      targetSessionQuery += ' AND session_type = ?';
      targetSessionQueryParams.push(activeFilterKey);
    }
    targetSessionQuery += ' ORDER BY id DESC LIMIT 1';

    const [targetSessions] = await pool.query(targetSessionQuery, targetSessionQueryParams);
    const activeTargetSession = targetSessions.length > 0 ? targetSessions[0] : null;

    const now = new Date();
    let global_session_status = 'Offline';
    if (activeTargetSession && activeTargetSession.starts_at && activeTargetSession.ends_at) {
      if (now >= new Date(activeTargetSession.starts_at) && now <= new Date(activeTargetSession.ends_at)) {
        global_session_status = 'Active';
      }
    }

    for (const f of floors) {
      let present_students = 0;
      
      if (activeTargetSession) {
        const [[{ present_count }]] = await pool.query(`
          SELECT COUNT(DISTINCT TRIM(LEADING '0' FROM ar.bank_code)) AS present_count 
          FROM attendance_records ar
          JOIN students st ON TRIM(LEADING '0' FROM st.student_code) = TRIM(LEADING '0' FROM ar.bank_code)
          WHERE ar.session_id = ? AND ar.floor_id = ? AND st.is_active = TRUE
        `, [activeTargetSession.id, f.floor_id]);
        present_students = present_count;
      }

      const [[{ floor_total }]] = await pool.query('SELECT COUNT(*) AS floor_total FROM students WHERE floor_id = ? AND is_active = TRUE', [f.floor_id]);

      floor_status.push({
        floor_id: f.floor_id,
        floor_name: f.floor_name,
        present: present_students,
        total: floor_total,
        percentage: floor_total > 0 ? Math.round((present_students / floor_total) * 100) : 0
      });
    }

    // 8. Find students absent for the last 3 days who have NOT provided justification
    const [distinctDatesRows] = await pool.query('SELECT DISTINCT session_date FROM attendance_sessions ORDER BY session_date DESC LIMIT 3');
    let targetDates = distinctDatesRows.map(r => {
      const d = new Date(r.session_date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });

    if (targetDates.length < 3) {
      const today = new Date();
      targetDates = [0, 1, 2].map(offset => {
        const d = new Date(today);
        d.setDate(d.getDate() - offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
    }

    let activeStudentsQuery = `
      SELECT s.id, s.student_code, s.name, s.floor_id, s.room_number, s.phone_number, f.floor_name
      FROM students s
      LEFT JOIN floors f ON s.floor_id = f.floor_id
      WHERE s.is_active = TRUE
    `;
    const activeStudentsParams = [];
    if (leaderFloors && leaderFloors.length > 0) {
      activeStudentsQuery += ' AND s.floor_id IN (?)';
      activeStudentsParams.push(leaderFloors);
    }
    activeStudentsQuery += ' ORDER BY s.floor_id ASC, s.room_number ASC, s.name ASC';

    const [activeStudents] = await pool.query(activeStudentsQuery, activeStudentsParams);

    let recentAttendanceRecords = [];
    let recentJustifications = [];

    if (targetDates.length > 0) {
      const [recRows] = await pool.query(`
        SELECT ar.student_id, TRIM(LEADING '0' FROM ar.bank_code) as bank_code, ses.session_date
        FROM attendance_records ar
        JOIN attendance_sessions ses ON ar.session_id = ses.id
        WHERE ses.session_date IN (?)
      `, [targetDates]);
      recentAttendanceRecords = recRows;

      const [justRows] = await pool.query(`
        SELECT student_id, session_date, reason, is_justified
        FROM attendance_absent_reasons
        WHERE session_date IN (?) AND is_justified = 1
      `, [targetDates]);
      recentJustifications = justRows;
    }

    const attendedSet = new Set();
    for (const r of recentAttendanceRecords) {
      const dateStr = new Date(r.session_date).toISOString().slice(0, 10);
      if (r.student_id) attendedSet.add(`${r.student_id}_${dateStr}`);
      if (r.bank_code) attendedSet.add(`${r.bank_code}_${dateStr}`);
    }

    const justifiedSet = new Set();
    const justificationMap = new Map();
    for (const j of recentJustifications) {
      const dateStr = new Date(j.session_date).toISOString().slice(0, 10);
      justifiedSet.add(`${j.student_id}_${dateStr}`);
      if (j.reason) {
        justificationMap.set(`${j.student_id}_${dateStr}`, j.reason);
        justificationMap.set(j.student_id, j.reason);
      }
    }

    // Fetch student tags
    const [tagRows] = await pool.query(`
      SELECT sta.student_id, t.id as tag_id, t.name, t.color, t.is_system, t.description
      FROM student_tag_assignments sta
      JOIN student_tags t ON sta.tag_id = t.id
    `);
    const tagsMap = {};
    for (const tr of tagRows) {
      if (!tagsMap[tr.student_id]) tagsMap[tr.student_id] = [];
      tagsMap[tr.student_id].push({
        id: tr.tag_id,
        name: tr.name,
        color: tr.color,
        is_system: tr.is_system,
        description: tr.description
      });
    }

    const consecutive_absentees = [];
    for (const s of activeStudents) {
      const cleanCode = (s.student_code || '').replace(/^0+/, '');
      const missedDates = [];
      const justifiedDates = [];
      let studentJustification = '';

      for (const d of targetDates) {
        const attended = attendedSet.has(`${s.id}_${d}`) || attendedSet.has(`${cleanCode}_${d}`);
        const isJust = justifiedSet.has(`${s.id}_${d}`);
        if (!attended) {
          missedDates.push(d);
          if (isJust) {
            justifiedDates.push(d);
            studentJustification = justificationMap.get(`${s.id}_${d}`) || studentJustification || justificationMap.get(s.id);
          }
        }
      }

      // If student was absent for all 3 days
      if (missedDates.length >= 3) {
        const isJustified = justifiedDates.length > 0;
        consecutive_absentees.push({
          student_id: s.id,
          student_code: s.student_code,
          name: s.name,
          floor_id: s.floor_id,
          floor_name: s.floor_name || `Floor ${s.floor_id}`,
          room_number: s.room_number || 'N/A',
          phone_number: s.phone_number || '',
          tags: tagsMap[s.id] || [],
          consecutive_days: missedDates.length,
          missed_dates: missedDates,
          justified_dates: justifiedDates,
          is_justified: isJustified,
          justification_reason: studentJustification || (isJustified ? 'Justification provided' : ''),
          status: isJustified ? 'Justified Absent' : 'Unjustified Absent'
        });
      }
    }

    return res.json({
      success: true,
      data: {
        total_students,
        present_today,
        late_today,
        absent_today,
        recent_session_name: recentSessionName,
        recent_session_key: recentSessionKey,
        current_session: {
          key: activeFilterKey,
          name: targetSessionName,
          is_recent: activeFilterKey === recentSessionKey
        },
        available_sessions,
        weekly_stats,
        floor_status,
        consecutive_absentees,
        target_dates: targetDates,
        is_leader_view: Boolean(leaderFloors && leaderFloors.length > 0),
        assigned_floors: leaderFloors || []
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/admin/rebind-requests
// ------------------------------------------------------------
router.get('/rebind-requests', async (req, res) => {
  try {
    const floorId = req.query.floor_id;
    let query = `
       SELECT rr.id, rr.student_id, s.student_code, s.name, s.phone_number,
              rr.new_device_uuid, rr.status, rr.created_at, f.floor_name
       FROM rebind_requests rr
       JOIN students s ON s.id = rr.student_id
       LEFT JOIN floors f ON rr.floor_id = f.floor_id
       WHERE rr.status IN ('pending','code_generated')
    `;
    const params = [];
    
    if (floorId && floorId !== 'ALL') {
      query += ` AND rr.floor_id = ?`;
      params.push(floorId);
    }
    
    query += ` ORDER BY rr.created_at ASC`;
    
    const [rows] = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/admin/rebind-requests/:id/generate-code
// ------------------------------------------------------------
router.post('/rebind-requests/:id/generate-code', async (req, res) => {
  try {
    const requestId = req.params.id;

    const [rows] = await pool.query('SELECT * FROM rebind_requests WHERE id = ?', [requestId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Rebind request not found' });
    }
    const reqRow = rows[0];

    if (reqRow.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Already completed' });
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MIN * 60 * 1000);

    // Using admin.id from token
    await pool.query(
      `UPDATE rebind_requests
       SET status = 'code_generated', code_hash = ?, code_expires_at = ?, generated_by = ?
       WHERE id = ?`,
      [codeHash, expiresAt, req.admin.id, requestId]
    );

    return res.json({
      success: true,
      code,
      expires_at: expiresAt,
      message: 'Read this code to the student. It expires in ' + CODE_EXPIRY_MIN + ' minutes.'
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/admin/esp32/status
// ------------------------------------------------------------
router.get('/esp32/status', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT floor_id, floor_name, device_name, last_seen FROM floors WHERE floor_id >= 0 ORDER BY floor_id ASC');
    
    const floors = rows.map(r => {
      const lastSeen = r.last_seen ? new Date(r.last_seen) : null;
      const now = new Date();
      // Consider online if heartbeat was within the last 2 minutes (120000 ms)
      const isOnline = lastSeen ? (now - lastSeen < 120000) : false;
      return {
        floor_id: r.floor_id,
        floor_name: r.floor_name,
        device_name: r.device_name,
        last_seen: r.last_seen,
        is_online: isOnline
      };
    });

    return res.json({ success: true, data: floors });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/admin/esp32/assign
// ------------------------------------------------------------
router.post('/esp32/assign', async (req, res) => {
  try {
    const { device_name, floor_id } = req.body;
    if (!device_name || floor_id === undefined) {
      return res.status(400).json({ success: false, message: 'Missing device_name or floor_id' });
    }

    // Unassign this device from any other floor first
    await pool.query('UPDATE floors SET device_name = NULL, last_seen = NULL WHERE device_name = ?', [device_name]);

    // Assign to new floor
    await pool.query('UPDATE floors SET device_name = ?, last_seen = NULL WHERE floor_id = ?', [device_name, floor_id]);

    return res.json({ success: true, message: 'ESP-32 assigned successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/admin/esp32/unassign
// ------------------------------------------------------------
router.post('/esp32/unassign', async (req, res) => {
  try {
    const { floor_id } = req.body;
    if (floor_id === undefined) {
      return res.status(400).json({ success: false, message: 'Missing floor_id' });
    }

    await pool.query('UPDATE floors SET device_name = NULL, last_seen = NULL WHERE floor_id = ?', [floor_id]);

    return res.json({ success: true, message: 'ESP-32 unassigned successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/admin/sessions
// ------------------------------------------------------------
router.get('/sessions', async (req, res) => {
  try {
    let query = 'SELECT * FROM attendance_schedules WHERE is_active = TRUE';
    const params = [];

    if (req.leader && Array.isArray(req.leader.assigned_sessions) && req.leader.assigned_sessions.length > 0 && !req.leader.assigned_sessions.includes('all')) {
      query += ' AND session_key IN (?)';
      params.push(req.leader.assigned_sessions);
    }

    query += ' ORDER BY start_time ASC';
    const [rows] = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/admin/sessions/:session_key
// ------------------------------------------------------------
router.get('/sessions/:session_key', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM attendance_schedules WHERE session_key = ?', [req.params.session_key]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/admin/sessions
// ------------------------------------------------------------
router.post('/sessions', verifyAdmin, async (req, res) => {
  try {
    const { session_name, icon_name, is_for_all_students } = req.body;
    if (!session_name || !icon_name) {
      return res.status(400).json({ success: false, message: 'Missing session_name or icon_name' });
    }
    const session_key = session_name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const isForAll = is_for_all_students === false || is_for_all_students === 0 || is_for_all_students === 'false' ? 0 : 1;
    
    await pool.query(
      'INSERT INTO attendance_schedules (session_key, session_name, icon_name, is_for_all_students, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)',
      [session_key, session_name, icon_name, isForAll, '00:00', '00:00']
    );
    
    return res.json({ 
      success: true, 
      message: 'Session added successfully',
      data: {
        session_key,
        session_name,
        icon_name,
        is_for_all_students: isForAll === 1
      }
    });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'A session with this name already exists' });
    }
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// PUT /api/admin/sessions/:session_key
// ------------------------------------------------------------
router.put('/sessions/:session_key', verifyAdmin, async (req, res) => {
  try {
    const { session_name, is_for_all_students } = req.body;
    const { session_key } = req.params;
    
    const [existing] = await pool.query('SELECT * FROM attendance_schedules WHERE session_key = ?', [session_key]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const updatedName = session_name ? session_name.trim() : existing[0].session_name;
    const isForAll = is_for_all_students !== undefined 
      ? (is_for_all_students ? 1 : 0) 
      : existing[0].is_for_all_students;
    
    await pool.query(
      'UPDATE attendance_schedules SET session_name = ?, is_for_all_students = ? WHERE session_key = ?',
      [updatedName, isForAll, session_key]
    );
    
    return res.json({ success: true, message: 'Session updated successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// DELETE /api/admin/sessions/:session_key
// ------------------------------------------------------------
router.delete('/sessions/:session_key', async (req, res) => {
  try {
    const { session_key } = req.params;
    
    // We could either DELETE it completely or just set is_active = FALSE.
    // Let's actually delete it to keep it clean.
    await pool.query('DELETE FROM attendance_schedules WHERE session_key = ?', [session_key]);
    
    return res.json({ success: true, message: 'Session deleted successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/admin/reports
// ------------------------------------------------------------
router.get('/reports', async (req, res) => {
  try {
    const timeFilter = req.query.time_filter;
    const floorIdFilter = req.query.floor_id;
    let dateConditionSessions = 'WHERE 1=1';
    let dateConditionAttendance = 'WHERE 1=1';
    
    let sessionCountsParams = [];
    let attendanceParams = [];

    if (timeFilter === 'today') {
      dateConditionSessions += ' AND session_date = CURDATE()';
      dateConditionAttendance += ' AND s.session_date = CURDATE()';
    } else if (timeFilter && timeFilter !== 'all') {
      // Treat as custom date (YYYY-MM-DD)
      dateConditionSessions += ' AND session_date = ?';
      dateConditionAttendance += ' AND s.session_date = ?';
      sessionCountsParams.push(timeFilter);
      attendanceParams.push(timeFilter);
    }

    let leaderFloors = null;
    if (req.leader) {
      leaderFloors = Array.isArray(req.leader.assigned_floors) && req.leader.assigned_floors.length > 0
        ? req.leader.assigned_floors.map(f => parseInt(f, 10)).filter(f => !isNaN(f))
        : (req.leader.floor_id !== undefined ? [parseInt(req.leader.floor_id, 10)] : []);
    }

    if (floorIdFilter) {
      dateConditionAttendance += ' AND ar.floor_id = ?';
      attendanceParams.push(floorIdFilter);
    } else if (leaderFloors && leaderFloors.length > 0) {
      dateConditionAttendance += ' AND ar.floor_id IN (?)';
      attendanceParams.push(leaderFloors);
    }

    // 1. Get total counts per session type
    const [sessionCounts] = await pool.query(`
      SELECT session_type, COUNT(id) as total
      FROM attendance_sessions
      ${dateConditionSessions}
      GROUP BY session_type
    `, sessionCountsParams);
    
    const totals = {};
    sessionCounts.forEach(s => {
      if(s.session_type) totals[s.session_type] = s.total;
    });

    // 2. Get attendance counts per student per session type
    const [attendance] = await pool.query(`
      SELECT TRIM(LEADING '0' FROM ar.bank_code) as bank_code, s.session_type, COUNT(*) as attended, SUM(ar.is_late) as late_count
      FROM attendance_records ar
      JOIN attendance_sessions s ON ar.session_id = s.id
      ${dateConditionAttendance}
      GROUP BY TRIM(LEADING '0' FROM ar.bank_code), s.session_type
    `, attendanceParams);

    const studentRecords = {};
    const lateRecords = {};

    attendance.forEach(a => {
      if (!studentRecords[a.bank_code]) {
        studentRecords[a.bank_code] = {};
      }
      if (a.session_type) studentRecords[a.bank_code][a.session_type] = a.attended;

      if (!lateRecords[a.bank_code]) {
        lateRecords[a.bank_code] = 0;
      }
      lateRecords[a.bank_code] += (parseInt(a.late_count) || 0);
    });

    // 3. Get active students metadata (room, floor, contact)
    let studentQuery = `
      SELECT s.id, s.student_code, s.name, s.floor_id, s.room_number, s.phone_number, f.floor_name
      FROM students s
      LEFT JOIN floors f ON s.floor_id = f.floor_id
      WHERE s.is_active = TRUE
    `;
    let studentQueryParams = [];
    if (leaderFloors && leaderFloors.length > 0) {
      studentQuery += ' AND s.floor_id IN (?)';
      studentQueryParams.push(leaderFloors);
    } else if (floorIdFilter && floorIdFilter !== 'All') {
      studentQuery += ' AND s.floor_id = ?';
      studentQueryParams.push(floorIdFilter);
    }
    studentQuery += ' ORDER BY s.floor_id ASC, s.room_number ASC, s.name ASC';

    const [students] = await pool.query(studentQuery, studentQueryParams);

    // 4. Fetch tags for these students
    const [tagRows] = await pool.query(`
      SELECT sta.student_id, t.id as tag_id, t.name, t.color, t.is_system, t.description
      FROM student_tag_assignments sta
      JOIN student_tags t ON sta.tag_id = t.id
    `);
    const tagsMap = {};
    for (const tr of tagRows) {
      if (!tagsMap[tr.student_id]) tagsMap[tr.student_id] = [];
      tagsMap[tr.student_id].push({
        id: tr.tag_id,
        name: tr.name,
        color: tr.color,
        is_system: tr.is_system,
        description: tr.description
      });
    }

    const enrichedStudents = students.map(s => {
      let finalFloorId = s.floor_id;
      let finalFloorName = s.floor_name;
      if ((finalFloorId === null || finalFloorId === undefined) && s.room_number && !isNaN(parseInt(s.room_number, 10))) {
        const rNum = parseInt(s.room_number, 10);
        if (rNum >= 100) {
          finalFloorId = Math.floor(rNum / 100);
          finalFloorName = `Floor ${finalFloorId}`;
        }
      }
      return {
        ...s,
        floor_id: finalFloorId,
        floor_name: finalFloorName || (finalFloorId !== null && finalFloorId !== undefined ? `Floor ${finalFloorId}` : null),
        tags: tagsMap[s.id] || []
      };
    });

    return res.json({ success: true, totals, studentRecords, lateRecords, students: enrichedStudents });
  } catch (err) {
    console.error('Reports Error:', err);
    return res.status(500).json({ success: false, message: err.toString() });
  }
});

router.get('/debug-reports', async (req, res) => {
  try {
    const [res1] = await pool.query('DESCRIBE attendance_records');
    const [res2] = await pool.query('DESCRIBE attendance_sessions');
    return res.json({ success: true, records: res1, sessions: res2 });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

module.exports = router;
