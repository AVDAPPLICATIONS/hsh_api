const express = require('express');
const router = express.Router();
const pool = require('../../config/db').default || require('../../config/db');
const { verifyStudent, verifyFloorLeader, verifyAdminOrFloorLeader, verifyOperator, requireAuth } = require('../../middleware/auth');
const admin = require('../../config/firebase').default || require('../../config/firebase');
const crypto = require('crypto');
const axios = require('axios');
const { getCurrentIST, getISTMinutes, getISTDateString } = require('../../utils/time');

const SECRET_KEY = process.env.AES_SECRET_KEY || 'HAMS_SECRET_KEY!'; // Must be 16 bytes for AES-128

const MIN_RSSI = parseInt(process.env.MIN_RSSI || '-100', 10);

// ------------------------------------------------------------
// GET /api/attendance (List history for student / filters)
// ------------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  try {
    const studentId = req.student?.id || req.user?.student_id;
    const { type, startDate, endDate, from, to, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT r.id, r.student_id, r.bank_code, r.student_name, r.marked_at,
             ses.session_date, ses.session_type, ses.starts_at, ses.ends_at
      FROM attendance_records r
      LEFT JOIN attendance_sessions ses ON r.session_id = ses.id
      WHERE 1=1
    `;
    const params = [];
    if (studentId) {
      query += ' AND r.student_id = ?';
      params.push(studentId);
    }
    if (type) {
      query += ' AND LOWER(ses.session_type) = LOWER(?)';
      params.push(type);
    }
    const start = startDate || from;
    if (start) {
      query += ' AND (ses.session_date >= ? OR DATE(r.marked_at) >= ?)';
      params.push(start, start);
    }
    const end = endDate || to;
    if (end) {
      query += ' AND (ses.session_date <= ? OR DATE(r.marked_at) <= ?)';
      params.push(end, end);
    }
    query += ' ORDER BY r.marked_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 50, parseInt(offset, 10) || 0);

    const [rows] = await pool.query(query, params);
    const formatted = (rows || []).map(r => ({
      id: r.id,
      aadhar: r.bank_code,
      studentAadhar: r.bank_code,
      studentName: r.student_name,
      date: r.session_date || r.marked_at,
      time: r.marked_at,
      type: r.session_type || 'night',
      viaCode: true
    }));

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error fetching attendance list:', err);
    return res.json({ success: true, data: [] });
  }
});

// ------------------------------------------------------------
// POST /api/attendance (Mark attendance)
// ------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  try {
    const studentId = req.student?.id || req.user?.student_id;
    const { type = 'night', viaCode = true } = req.body;
    const now = getCurrentIST();
    const dateStr = now.toISOString().slice(0, 10);

    const [students] = await pool.query('SELECT name, student_code, floor_id FROM students WHERE id = ?', [studentId]);
    const studentName = students[0]?.name || 'Student';
    const bankCode = students[0]?.student_code || '';
    const floorId = students[0]?.floor_id || 0;

    let [sessions] = await pool.query('SELECT id FROM attendance_sessions WHERE session_date = ? AND LOWER(session_type) = LOWER(?) LIMIT 1', [dateStr, type]);
    let sessionId;
    if (sessions.length > 0) {
      sessionId = sessions[0].id;
    } else {
      const [newSes] = await pool.query('INSERT INTO attendance_sessions (session_date, session_type, starts_at, ends_at) VALUES (?, ?, NOW(), NOW())', [dateStr, type]);
      sessionId = newSes.insertId;
    }

    const [insertResult] = await pool.query(
      'INSERT INTO attendance_records (session_id, bank_code, student_name, student_id, floor_id, marked_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [sessionId, bankCode, studentName, studentId, floorId]
    );

    return res.status(201).json({
      success: true,
      data: {
        id: insertResult.insertId,
        aadhar: bankCode,
        studentAadhar: bankCode,
        studentName,
        date: now,
        time: now,
        type,
        viaCode
      }
    });
  } catch (err) {
    console.error('Error marking attendance:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/my-status
// Returns the student's attendance status for today
// ------------------------------------------------------------
router.get('/my-status', verifyStudent, async (req, res) => {
  try {
    const studentId = req.student.id;
    const floorId = req.student.floor_id || 0; // Default to 0 if undefined to prevent mysql2 crash

    // Fetch all schedules from dynamic table
    const [scheduleRows] = await pool.query(
      'SELECT session_key, session_name, icon_name, start_time, end_time FROM attendance_schedules WHERE is_active = TRUE ORDER BY start_time ASC'
    );

    const allSchedules = scheduleRows.map(r => ({
      session_key: r.session_key,
      session_name: r.session_name,
      icon_name: r.icon_name || 'moon',
      start_time: (r.start_time || '00:00').slice(0, 5),
      end_time: (r.end_time || '00:00').slice(0, 5)
    }));

    const schedules = {};
    for (const row of allSchedules) {
      schedules[row.session_key] = { start: row.start_time, end: row.end_time, name: row.session_name };
    }

    const now = getCurrentIST();
    const sessionDate = now.toISOString().slice(0, 10);
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    let activeSession = null;

    for (const sched of allSchedules) {
      const [startH, startM] = sched.start_time.split(':').map(Number);
      const [endH, endM] = sched.end_time.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      if (startMinutes > endMinutes) {
        // Overnight window (e.g. 22:30 to 06:00)
        if (nowMinutes >= startMinutes || nowMinutes <= endMinutes) {
          activeSession = sched;
          break;
        }
      } else if (startMinutes < endMinutes) {
        // Normal window (e.g. 06:00 to 07:00, 19:00 to 19:30, 22:30 to 23:05)
        if (nowMinutes >= startMinutes && nowMinutes <= endMinutes) {
          activeSession = sched;
          break;
        }
      }
    }

    let attendanceActive = activeSession !== null;
    let activeSessionType = activeSession ? activeSession.session_key : null;
    let activeSessionName = activeSession ? activeSession.session_name : (allSchedules[0]?.session_name || 'Night Attendance');
    let startTimeStr = activeSession ? activeSession.start_time : (allSchedules[0]?.start_time || '22:30');
    let endTimeStr = activeSession ? activeSession.end_time : (allSchedules[0]?.end_time || '23:05');

    let alreadyMarked = false;
    let bankCode = null;

    const [studentRows] = await pool.query('SELECT student_code FROM students WHERE id = ?', [studentId]);
    if (studentRows.length > 0) {
      bankCode = studentRows[0].student_code;

      if (attendanceActive && activeSessionType) {
        // Enforce Floor Leader Targets
        const [targetRows] = await pool.query(
          'SELECT target_type, student_ids FROM floor_session_targets WHERE floor_id = ? AND session_key = ?',
          [floorId, activeSessionType]
        );
        if (targetRows.length > 0) {
          const target = targetRows[0];
          if (target.target_type === 'SELECTED') {
            const ids = target.student_ids || [];
            if (!ids.includes(bankCode)) {
              attendanceActive = false;
              activeSessionType = null;
            }
          }
        }
      }

      if (activeSessionType) {
        // 1. Check local database first
        const [sessions] = await pool.query('SELECT id FROM attendance_sessions WHERE session_date = ? AND session_type = ?', [sessionDate, activeSessionType]);
        if (sessions.length > 0) {
          const sessionIds = sessions.map(s => s.id);
          const [localRecords] = await pool.query('SELECT session_id FROM attendance_records WHERE session_id IN (?) AND (bank_code = ? OR student_id = ?)', [sessionIds, bankCode, studentId]);
          if (localRecords.length > 0) {
            alreadyMarked = true;
          }
        }
      }
    }

    return res.json({
      success: true,
      data: {
        already_marked: alreadyMarked,
        start_time: startTimeStr,
        end_time: endTimeStr,
        attendance_active: attendanceActive,
        active_session_type: activeSessionType,
        session_name: activeSessionName,
        all_schedules: allSchedules,
        schedules: schedules
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Could not check attendance status. Please try again.' });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/schedule
// ------------------------------------------------------------
router.get('/schedule', async (req, res) => {
  try {
    const type = (req.query.type || 'night').toLowerCase();
    const [rows] = await pool.query(
      'SELECT start_time, end_time, late_time, linked_session_key, auto_message, auto_message_student, auto_message_parent, auto_message_time, auto_message_audience, is_for_all_students FROM attendance_schedules WHERE session_key = ?',
      [type]
    );
    let startTimeStr = '00:00';
    let endTimeStr = '00:00';
    let lateTimeStr = null;
    let linkedSessionKey = null;
    let autoMessage = null;
    let autoMessageStudent = null;
    let autoMessageParent = null;
    let autoMessageTime = null;
    let autoMessageAudience = 'all';

    if (rows.length > 0) {
      startTimeStr = rows[0].start_time;
      endTimeStr = rows[0].end_time;
      lateTimeStr = rows[0].late_time;
      linkedSessionKey = rows[0].linked_session_key;
      autoMessage = rows[0].auto_message_student || rows[0].auto_message;
      autoMessageStudent = rows[0].auto_message_student || rows[0].auto_message;
      autoMessageParent = rows[0].auto_message_parent;
      autoMessageTime = rows[0].auto_message_time;
      autoMessageAudience = rows[0].auto_message_audience;
    }

    return res.json({
      success: true,
      data: {
        start_time: startTimeStr,
        end_time: endTimeStr,
        late_time: lateTimeStr,
        linked_session_key: linkedSessionKey,
        auto_message: autoMessage,
        auto_message_student: autoMessageStudent,
        auto_message_parent: autoMessageParent,
        auto_message_time: autoMessageTime,
        auto_message_audience: autoMessageAudience
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// PUT /api/attendance/schedule
// ------------------------------------------------------------
router.put('/schedule', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const {
      startTime,
      endTime,
      type,
      lateTime,
      linkedSessionKey,
      autoMessage,
      autoMessageStudent,
      autoMessageParent,
      autoMessageTime
    } = req.body;
    const sessionType = (type || 'night').toLowerCase();

    if (!startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'Missing startTime or endTime' });
    }

    // Validation: Auto-message time must be AFTER attendance end time
    if (autoMessageTime && autoMessageTime.trim()) {
      const [endH, endM] = endTime.split(':').map(Number);
      const [msgH, msgM] = autoMessageTime.split(':').map(Number);
      const endMins = endH * 60 + endM;
      const msgMins = msgH * 60 + msgM;

      // Handle normal & overnight windows
      const [startH, startM] = startTime.split(':').map(Number);
      const startMins = startH * 60 + startM;

      if (startMins <= endMins) {
        // Normal daytime window (e.g. 07:00 to 19:30)
        if (msgMins <= endMins) {
          return res.status(400).json({
            success: false,
            message: `Automated message time (${autoMessageTime}) must be set AFTER attendance end time (${endTime})!`
          });
        }
      }
    }

    const studentMsg = (autoMessageStudent !== undefined ? autoMessageStudent : autoMessage) || null;
    const parentMsg = autoMessageParent !== undefined ? autoMessageParent : null;

    await pool.query(
      `UPDATE attendance_schedules 
       SET start_time = ?, end_time = ?, late_time = ?, linked_session_key = ?, 
           auto_message = ?, auto_message_student = ?, auto_message_parent = ?, auto_message_time = ?, auto_message_audience = 'absent' 
       WHERE session_key = ?`,
      [
        startTime,
        endTime,
        lateTime || null,
        linkedSessionKey || null,
        (studentMsg && studentMsg.trim()) ? studentMsg.trim() : null,
        (studentMsg && studentMsg.trim()) ? studentMsg.trim() : null,
        (parentMsg && parentMsg.trim()) ? parentMsg.trim() : null,
        (autoMessageTime && autoMessageTime.trim()) ? autoMessageTime.trim() : null,
        sessionType
      ]
    );

    const now = getCurrentIST();
    if (startTime !== endTime) {
      try {
        const [students] = await pool.query('SELECT fcm_token FROM students WHERE fcm_token IS NOT NULL');
        const tokens = students.map(s => s.fcm_token).filter(t => t);

        if (tokens.length > 0) {
          const message = {
            notification: {
              title: `${sessionType} Attendance Update ⏰`,
              body: `The ${sessionType.toLowerCase()} attendance window has been scheduled from ${startTime} to ${endTime}.`,
            },
            tokens: tokens,
          };

          admin.messaging().sendMulticast(message)
            .then((response) => console.log(response.successCount + ' messages sent'))
            .catch((error) => console.error('Error sending FCM:', error));
        }
      } catch (fcmErr) {
        console.error('FCM DB error:', fcmErr);
      }
    }

    return res.json({ success: true, message: `${sessionType} schedule and alert settings updated successfully` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// ------------------------------------------------------------
// PUT /api/attendance/schedule/:session_key/auto-message
// ------------------------------------------------------------
router.put('/schedule/:session_key/auto-message', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const sessionKey = req.params.session_key.toLowerCase();
    const { auto_message, auto_message_student, auto_message_parent, auto_message_time, auto_message_audience } = req.body;

    // Check against session end time
    if (auto_message_time && auto_message_time.trim()) {
      const [rows] = await pool.query('SELECT end_time, start_time FROM attendance_schedules WHERE session_key = ?', [sessionKey]);
      if (rows.length > 0 && rows[0].end_time) {
        const [endH, endM] = rows[0].end_time.split(':').map(Number);
        const [msgH, msgM] = auto_message_time.split(':').map(Number);
        const endMins = endH * 60 + endM;
        const msgMins = msgH * 60 + msgM;
        if (msgMins <= endMins) {
          return res.status(400).json({
            success: false,
            message: `Automated message time must be set AFTER attendance end time (${rows[0].end_time.slice(0, 5)})!`
          });
        }
      }
    }

    const studentMsg = (auto_message_student !== undefined ? auto_message_student : auto_message) || null;
    const parentMsg = auto_message_parent !== undefined ? auto_message_parent : null;

    await pool.query(
      'UPDATE attendance_schedules SET auto_message = ?, auto_message_student = ?, auto_message_parent = ?, auto_message_time = ?, auto_message_audience = ? WHERE session_key = ?',
      [
        (studentMsg && studentMsg.trim()) ? studentMsg.trim() : null,
        (studentMsg && studentMsg.trim()) ? studentMsg.trim() : null,
        (parentMsg && parentMsg.trim()) ? parentMsg.trim() : null,
        (auto_message_time && auto_message_time.trim()) ? auto_message_time.trim() : null,
        auto_message_audience || 'absent',
        sessionKey
      ]
    );

    return res.json({ success: true, message: 'Auto-message saved successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/attendance/session/:session_key/send-absent-alerts
// ------------------------------------------------------------
router.post('/session/:session_key/send-absent-alerts', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const sessionKey = req.params.session_key.toLowerCase();
    const { studentMessageTemplate, parentMessageTemplate, messageTemplate, date } = req.body;
    const { sendMessage } = require('../services/whatsapp');

    const sessionDate = date || getCurrentIST().toISOString().slice(0, 10);

    const [scheduleRows] = await pool.query(
      'SELECT session_name, auto_message, auto_message_student, auto_message_parent, is_for_all_students FROM attendance_schedules WHERE session_key = ?',
      [sessionKey]
    );

    const activeStudentTemplate = (
      studentMessageTemplate !== undefined
        ? studentMessageTemplate
        : (messageTemplate !== undefined ? messageTemplate : (scheduleRows[0] && (scheduleRows[0].auto_message_student || scheduleRows[0].auto_message)))
    ) || '';

    const activeParentTemplate = (
      parentMessageTemplate !== undefined
        ? parentMessageTemplate
        : (scheduleRows[0] && scheduleRows[0].auto_message_parent)
    ) || '';

    const trimmedStudentTemplate = activeStudentTemplate.trim();
    const trimmedParentTemplate = activeParentTemplate.trim();

    if (!trimmedStudentTemplate && !trimmedParentTemplate) {
      return res.status(400).json({
        success: false,
        message: 'Please write a message in the Student box, Parent box, or both.'
      });
    }

    const sessionName = (scheduleRows[0] && scheduleRows[0].session_name) || sessionKey;
    const isForAll = scheduleRows.length === 0 || scheduleRows[0].is_for_all_students === 1 || scheduleRows[0].is_for_all_students === true;

    let targetFilterClause = '';
    const targetFilterParams = [sessionDate, sessionKey];

    if (!isForAll) {
      const [targetRows] = await pool.query('SELECT student_ids FROM floor_session_targets WHERE session_key = ? AND target_type = "SELECTED"', [sessionKey]);
      let assignedStudentIds = [];
      for (const tr of targetRows) {
        let sids = tr.student_ids;
        if (typeof sids === 'string') {
          try { sids = JSON.parse(sids); } catch (e) { sids = []; }
        }
        if (Array.isArray(sids)) {
          assignedStudentIds.push(...sids.map(id => String(id).trim()));
        }
      }

      if (assignedStudentIds.length === 0) {
        return res.json({ success: true, count: 0, message: 'No students are assigned to this selective session.' });
      }

      targetFilterClause = 'AND (s.id IN (?) OR s.student_code IN (?) OR TRIM(LEADING "0" FROM s.student_code) IN (?))';
      targetFilterParams.push(assignedStudentIds, assignedStudentIds, assignedStudentIds);
    }

    // If requester is a floor leader, restrict to their assigned floors
    if (req.leader) {
      const leaderFloors = Array.isArray(req.leader.assigned_floors) && req.leader.assigned_floors.length > 0
        ? req.leader.assigned_floors.map(f => parseInt(f, 10))
        : (req.leader.floor_id !== undefined ? [parseInt(req.leader.floor_id, 10)] : []);
      if (leaderFloors.length > 0) {
        targetFilterClause += ' AND s.floor_id IN (?)';
        targetFilterParams.push(leaderFloors);
      }
    }

    // Fetch absent students with student phone and parent phone numbers
    const query = `
      SELECT 
        s.phone_number as phone, 
        s.father_phone as fatherPhone,
        s.mother_phone as motherPhone,
        s.parent_phone as parentPhone,
        s.name, 
        s.student_code as bankCode, 
        s.room_number as roomNumber, 
        s.floor_id as floorId
      FROM students s
      WHERE s.is_active = TRUE
      AND TRIM(LEADING '0' FROM s.student_code) NOT IN (
        SELECT TRIM(LEADING '0' FROM r.bank_code)
        FROM attendance_records r
        JOIN attendance_sessions ses ON r.session_id = ses.id
        WHERE ses.session_date = ? AND LOWER(ses.session_type) = LOWER(?)
      )
      ${targetFilterClause}
    `;
    const [targetStudents] = await pool.query(query, targetFilterParams);

    if (targetStudents.length === 0) {
      return res.json({ success: true, count: 0, message: 'No absent students found for today.' });
    }

    // Format helper function
    const formatMessage = (tpl, student) => {
      let msg = tpl;
      msg = msg.replace(/{name}/gi, student.name || 'Student');
      msg = msg.replace(/{student_name}/gi, student.name || 'Student');
      msg = msg.replace(/{session_name}/gi, sessionName);
      msg = msg.replace(/{date}/gi, sessionDate);
      msg = msg.replace(/{room}/gi, student.roomNumber || 'N/A');
      msg = msg.replace(/{floor}/gi, student.floorId !== undefined ? `Floor ${student.floorId}` : '');
      msg = msg.replace(/{student_phone}/gi, student.phone || '');
      msg = msg.replace(/{parent_phone}/gi, student.parentPhone || student.fatherPhone || '');
      return msg;
    };

    // Process asynchronously in background with human-like delay so API responds immediately
    (async () => {
      let studentSentCount = 0;
      let parentSentCount = 0;

      for (const student of targetStudents) {
        // 1. Send to Student if student template is provided and phone exists
        if (trimmedStudentTemplate && student.phone) {
          const studentMsg = formatMessage(trimmedStudentTemplate, student);
          try {
            await sendMessage(student.phone, studentMsg);
            studentSentCount++;
            console.log(`[Absent Alerts] Sent student message to ${student.name} (${student.phone})`);
          } catch (waErr) {
            console.error(`[Absent Alerts] Failed to send student message to ${student.phone}:`, waErr.message);
          }
          await new Promise(resolve => setTimeout(resolve, 1200 + Math.random() * 800));
        }

        // 2. Send to Parent if parent template is provided and parent phone exists
        const parentDestination = student.parentPhone || student.fatherPhone || student.motherPhone;
        if (trimmedParentTemplate && parentDestination) {
          const parentMsg = formatMessage(trimmedParentTemplate, student);
          try {
            await sendMessage(parentDestination, parentMsg);
            parentSentCount++;
            console.log(`[Absent Alerts] Sent parent message for ${student.name} to parent (${parentDestination})`);
          } catch (waErr) {
            console.error(`[Absent Alerts] Failed to send parent message to ${parentDestination}:`, waErr.message);
          }
          await new Promise(resolve => setTimeout(resolve, 1200 + Math.random() * 800));
        }
      }

      console.log(`[Absent Alerts] Completed sending for ${sessionName}. Students: ${studentSentCount}, Parents: ${parentSentCount}`);
    })();

    let summaryText = '';
    if (trimmedStudentTemplate && trimmedParentTemplate) {
      summaryText = `Absent alerts process started for both Students and Parents (${targetStudents.length} absentees).`;
    } else if (trimmedStudentTemplate) {
      summaryText = `Absent alerts process started for Students only (${targetStudents.length} absentees).`;
    } else {
      summaryText = `Absent alerts process started for Parents only (${targetStudents.length} absentees).`;
    }

    return res.json({
      success: true,
      count: targetStudents.length,
      message: `${summaryText} Messages are being delivered in 1–2 second safe intervals.`
    });
  } catch (err) {
    console.error('Error triggering absent alerts:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/leave
// ------------------------------------------------------------
router.get('/leave', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const axios = require('axios');

    let url = 'https://api.avdvvn.org/public/getTmpLeave';
    const params = [];
    if (startDate) params.push(`startDate=${startDate}`);
    if (endDate) params.push(`endDate=${endDate}`);
    if (params.length > 0) {
      url += '?' + params.join('&');
    }

    const response = await axios.get(url, {
      headers: {
        'x-hsh-auth-token': 'aF92Kx7QmN4Lp8Vz'
      }
    });

    return res.json(response.data);
  } catch (error) {
    console.error('Error fetching tmp leave:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch leave data' });
  }
});

// ------------------------------------------------------------

// GET /api/attendance/debug-reports
// ------------------------------------------------------------
router.get('/debug-reports', async (req, res) => {
  try {
    const [res1] = await pool.query('DESCRIBE attendance_records');
    const [res2] = await pool.query('DESCRIBE attendance_sessions');

    // Test the actual query too
    let err1 = null;
    let counts = null;
    try {
      const [sessionCounts] = await pool.query(`
        SELECT session_type, COUNT(id) as total
        FROM attendance_sessions
        GROUP BY session_type
      `);
      counts = sessionCounts;
    } catch (e) { err1 = e.toString(); }

    return res.json({ success: true, records: res1, sessions: res2, err1, counts });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/debug-sql
// ------------------------------------------------------------
router.get('/debug-sql', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.json({ success: false, message: 'No query' });
    const [rows] = await pool.query(query);
    return res.json({ success: true, data: rows });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

// ------------------------------------------------------------
// POST /api/attendance/mark
// ------------------------------------------------------------
router.post('/mark', verifyStudent, async (req, res) => {
  try {
    const { rssi } = req.body;
    if (rssi === undefined) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const floorId = req.student.floor_id || 0;
    const studentId = req.student.id;

    // Fetch all schedules from dynamic table
    const [scheduleRows] = await pool.query(
      'SELECT session_key, start_time, end_time, linked_session_key, late_time FROM attendance_schedules WHERE is_active = TRUE'
    );

    const schedules = {};
    for (const row of scheduleRows) {
      schedules[row.session_key] = { start: row.start_time, end: row.end_time };
    }

    const now = getCurrentIST();
    const nowMinutes = typeof getISTMinutes === 'function' ? getISTMinutes() : (now.getHours() * 60 + now.getMinutes());
    const sessionDate = typeof getISTDateString === 'function' ? getISTDateString() : now.toISOString().slice(0, 10);
    let activeSessionType = null;
    let startDt = null;
    let endDt = null;
    const requestedType = (req.body.session_type || req.body.type || '').toString().toLowerCase();

    for (const [type, times] of (Object.entries(schedules) as [string, any][])) {
      const [startH, startM] = times.start.split(':').map(Number);
      const [endH, endM] = times.end.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      let isMatch = false;
      if (startMinutes > endMinutes) {
        if (nowMinutes >= startMinutes || nowMinutes <= endMinutes) {
          isMatch = true;
        }
      } else {
        if (nowMinutes >= startMinutes && nowMinutes <= endMinutes) {
          isMatch = true;
        }
      }

      if (isMatch || (requestedType && type.toLowerCase() === requestedType)) {
        activeSessionType = type;
        startDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), startH, startM, 0));
        endDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endH, endM, 0));
        if (isMatch) break;
      }
    }

    if (!activeSessionType) {
      return res.status(400).json({ success: false, code: 'NO_ACTIVE_SESSION', message: 'Attendance window is currently closed' });
    }

    // Enforce Floor Leader & Session Targets
    const [sessInfo] = await pool.query('SELECT is_for_all_students FROM attendance_schedules WHERE session_key = ?', [activeSessionType]);
    const isForAll = sessInfo.length === 0 || sessInfo[0].is_for_all_students === null || sessInfo[0].is_for_all_students === true || sessInfo[0].is_for_all_students === 1;

    const [targetRows] = await pool.query(
      'SELECT target_type, student_ids FROM floor_session_targets WHERE floor_id = ? AND session_key = ?',
      [floorId, activeSessionType]
    );

    if (!isForAll) {
      let isTargeted = false;
      if (targetRows.length > 0) {
        let ids = targetRows[0].student_ids || [];
        if (typeof ids === 'string') {
          try { ids = JSON.parse(ids); } catch (e) { ids = []; }
        }
        if (Array.isArray(ids) && (
          ids.includes(req.student.student_code) ||
          ids.includes(req.student.id) ||
          ids.includes(Number(req.student.id)) ||
          ids.includes(String(req.student.id))
        )) {
          isTargeted = true;
        }
      }
      if (!isTargeted) {
        return res.status(403).json({ success: false, code: 'NOT_TARGETED', message: 'You are not assigned to attend this session' });
      }
    } else if (targetRows.length > 0 && targetRows[0].target_type === 'SELECTED') {
      let ids = targetRows[0].student_ids || [];
      if (typeof ids === 'string') {
        try { ids = JSON.parse(ids); } catch (e) { ids = []; }
      }
      if (Array.isArray(ids) && !(
        ids.includes(req.student.student_code) ||
        ids.includes(req.student.id) ||
        ids.includes(Number(req.student.id)) ||
        ids.includes(String(req.student.id))
      )) {
        return res.status(403).json({ success: false, code: 'NOT_TARGETED', message: 'You are not assigned to attend this session' });
      }
    }

    if (rssi < MIN_RSSI) {
      return res.status(403).json({ success: false, code: 'WEAK_SIGNAL', message: 'Move closer to the classroom device' });
    }

    let [sessions] = await pool.query(
      `SELECT id FROM attendance_sessions WHERE session_date = ? AND session_type = ?`,
      [sessionDate, activeSessionType]
    );

    let activeSessionId;
    if (sessions.length === 0) {
      const [result] = await pool.query(
        `INSERT INTO attendance_sessions (session_date, starts_at, ends_at, session_type)
         VALUES (?, ?, ?, ?)`,
        [sessionDate, startDt, endDt, activeSessionType]
      );
      activeSessionId = result.insertId;
    } else {
      activeSessionId = sessions[0].id;
    }

    let [students] = await pool.query('SELECT student_code, name FROM students WHERE id = ?', [studentId]);
    if (students.length === 0) {
      if (req.student && req.student.student_code) {
        students = [{ student_code: req.student.student_code, name: req.student.name || 'Student' }];
      } else {
        return res.status(404).json({ success: false, message: 'Student not found' });
      }
    }

    const bankCode = students[0].student_code;
    const studentName = students[0].name;

    // Check if already marked for this session
    const [existing] = await pool.query(
      "SELECT session_id FROM attendance_records WHERE session_id = ? AND TRIM(LEADING '0' FROM bank_code) = TRIM(LEADING '0' FROM ?)",
      [activeSessionId, bankCode]
    );

    if (existing.length > 0) {
      return res.status(200).json({ success: true, message: 'Attendance already marked for today' });
    }

    // --- Late Logic ---
    const activeSchedule = scheduleRows.find(r => r.session_key === activeSessionType);
    let isLate = false;
    if (activeSchedule && activeSchedule.late_time) {
      const [lateH, lateM] = activeSchedule.late_time.split(':').map(Number);
      let lateDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), lateH, lateM, 0));
      // Handle cross-midnight late times (e.g., if late_time is 01:00 and now is 23:30)
      if (startDt.getTime() > endDt.getTime() && now.getUTCHours() > 12 && lateH < 12) {
        lateDt.setUTCDate(lateDt.getUTCDate() + 1);
      }
      if (now > lateDt) {
        isLate = true;
        // Check how many times they've been late this month
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const [lateCountRes] = await pool.query(
          "SELECT COUNT(*) as count FROM attendance_records WHERE TRIM(LEADING '0' FROM bank_code) = TRIM(LEADING '0' FROM ?) AND is_late = TRUE AND marked_at >= ?",
          [bankCode, monthStart]
        );
        if (lateCountRes[0].count >= 10) {
          return res.status(403).json({ success: false, code: 'LATE_LIMIT_EXCEEDED', message: 'You have exceeded the maximum allowed late days this month (10).' });
        }
      }
    }

    // Store in local MySQL DB
    await pool.query(
      `INSERT INTO attendance_records (session_id, bank_code, student_name, floor_id, device_uuid, rssi, ble_token_used, is_late)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [activeSessionId, bankCode, studentName, floorId, 'NA', rssi, 'BEACON_ONLY', isLate]
    );

    // --- Linked Session Logic ---
    if (activeSchedule && activeSchedule.linked_session_key) {
      let [linkedSessions] = await pool.query(
        `SELECT id FROM attendance_sessions WHERE session_date = ? AND session_type = ?`,
        [sessionDate, activeSchedule.linked_session_key]
      );
      let linkedSessionId;
      if (linkedSessions.length === 0) {
        const [result] = await pool.query(
          `INSERT INTO attendance_sessions (session_date, starts_at, ends_at, session_type) VALUES (?, ?, ?, ?)`,
          [sessionDate, startDt, endDt, activeSchedule.linked_session_key]
        );
        linkedSessionId = result.insertId;
      } else {
        linkedSessionId = linkedSessions[0].id;
      }

      await pool.query(
        `INSERT IGNORE INTO attendance_records (session_id, bank_code, student_name, floor_id, device_uuid, rssi, ble_token_used, is_late)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [linkedSessionId, bankCode, studentName, floorId, 'NA', rssi, 'LINKED_AUTO', false]
      );
    }

    console.log(`[INFO] Attendance marked successfully for ${bankCode}.`);
    return res.status(201).json({ success: true, message: 'Attendance marked successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// ------------------------------------------------------------
// POST /api/attendance/manual-mark (OPERATOR ONLY)
// ------------------------------------------------------------
router.post('/manual-mark', verifyOperator, async (req, res) => {
  try {
    const { bank_code, session_key } = req.body;
    if (!bank_code) {
      return res.status(400).json({ success: false, message: 'Missing bank code' });
    }

    // 1. Find student
    let studentId = null;
    let floorId = 0;
    let studentName = req.body.student_name || 'Unknown';

    // Default floor extraction from room string (e.g. "913" -> 9)
    if (req.body.room) {
      const match = req.body.room.toString().match(/^(\d)/);
      if (match) floorId = parseInt(match[1], 10);
    }

    const [students] = await pool.query('SELECT id, student_code, name, floor_id, is_active FROM students WHERE CAST(student_code AS UNSIGNED) = CAST(? AS UNSIGNED)', [bank_code]);
    if (students.length > 0) {
      const student = students[0];
      studentId = student.id;
      floorId = student.floor_id;
      studentName = student.name;
      if (!student.is_active) {
        await pool.query('UPDATE students SET is_active = TRUE WHERE id = ?', [studentId]);
      }
    } else {
      const [insertRes] = await pool.query(
        'INSERT INTO students (student_code, name, is_active, floor_id) VALUES (?, ?, 1, ?)',
        [bank_code, studentName, floorId]
      );
      studentId = insertRes.insertId;
    }

    // 2. Find active session
    const [scheduleRows] = await pool.query(
      'SELECT session_key, start_time, end_time FROM attendance_schedules WHERE is_active = TRUE'
    );

    const schedules = {};
    for (const row of scheduleRows) {
      schedules[row.session_key] = { start: row.start_time, end: row.end_time };
    }

    const now = getCurrentIST();
    let activeSessionType = null;
    let startDt = null;
    let endDt = null;

    if (session_key && schedules[session_key]) {
      // Operator selected a specific session
      activeSessionType = session_key;
      const times = schedules[session_key];
      const [startH, startM] = times.start.split(':').map(Number);
      const [endH, endM] = times.end.split(':').map(Number);
      startDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), startH, startM, 0));
      endDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endH, endM, 0));
    } else {
      // Auto-detect based on time
      for (const [type, times] of (Object.entries(schedules) as [string, any][])) {
        const [startH, startM] = times.start.split(':').map(Number);
        const [endH, endM] = times.end.split(':').map(Number);
        const currentStartDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), startH, startM, 0));
        const currentEndDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endH, endM, 0));

        if (currentStartDt.getTime() > currentEndDt.getTime()) {
          if (now >= currentStartDt || now <= currentEndDt) {
            activeSessionType = type;
            startDt = currentStartDt;
            endDt = currentEndDt;
            break;
          }
        } else {
          if (now >= currentStartDt && now <= currentEndDt) {
            activeSessionType = type;
            startDt = currentStartDt;
            endDt = currentEndDt;
            break;
          }
        }
      }
    }

    if (!activeSessionType) {
      return res.status(400).json({ success: false, message: 'No active attendance session currently open.' });
    }

    const sessionDate = now.toISOString().slice(0, 10);
    let [sessions] = await pool.query(
      `SELECT id FROM attendance_sessions WHERE session_date = ? AND session_type = ?`,
      [sessionDate, activeSessionType]
    );

    let activeSessionId;
    if (sessions.length === 0) {
      const [result] = await pool.query(
        `INSERT INTO attendance_sessions (session_date, starts_at, ends_at, session_type)
         VALUES (?, ?, ?, ?)`,
        [sessionDate, startDt, endDt, activeSessionType]
      );
      activeSessionId = result.insertId;
    } else {
      activeSessionId = sessions[0].id;
    }

    // 3. Check if already marked
    const [existing] = await pool.query(
      "SELECT session_id FROM attendance_records WHERE session_id = ? AND TRIM(LEADING '0' FROM bank_code) = TRIM(LEADING '0' FROM ?)",
      [activeSessionId, bank_code]
    );

    if (existing.length > 0) {
      return res.status(200).json({ success: true, message: 'Attendance already marked' });
    }

    // --- Late Logic ---
    const activeSchedule = scheduleRows.find(r => r.session_key === activeSessionType);
    let isLate = false;
    if (activeSchedule && activeSchedule.late_time) {
      const [lateH, lateM] = activeSchedule.late_time.split(':').map(Number);
      let lateDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), lateH, lateM, 0));
      if (startDt.getTime() > endDt.getTime() && now.getUTCHours() > 12 && lateH < 12) {
        lateDt.setUTCDate(lateDt.getUTCDate() + 1);
      }
      if (now > lateDt) {
        isLate = true;
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const [lateCountRes] = await pool.query(
          "SELECT COUNT(*) as count FROM attendance_records WHERE TRIM(LEADING '0' FROM bank_code) = TRIM(LEADING '0' FROM ?) AND is_late = TRUE AND marked_at >= ?",
          [bank_code, monthStart]
        );
        if (lateCountRes[0].count >= 10) {
          return res.status(403).json({ success: false, code: 'LATE_LIMIT_EXCEEDED', message: 'Student exceeded the maximum allowed late days this month (10).' });
        }
      }
    }

    // 4. Insert record
    await pool.query(
      `INSERT INTO attendance_records (session_id, bank_code, student_name, floor_id, device_uuid, rssi, ble_token_used, is_late)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [activeSessionId, bank_code, studentName, floorId, 'MANUAL', 0, 'MANUAL_ENTRY', isLate]
    );

    // --- Linked Session Logic ---
    if (activeSchedule && activeSchedule.linked_session_key) {
      let [linkedSessions] = await pool.query(
        `SELECT id FROM attendance_sessions WHERE session_date = ? AND session_type = ?`,
        [sessionDate, activeSchedule.linked_session_key]
      );
      let linkedSessionId;
      if (linkedSessions.length === 0) {
        const [result] = await pool.query(
          `INSERT INTO attendance_sessions (session_date, starts_at, ends_at, session_type) VALUES (?, ?, ?, ?)`,
          [sessionDate, startDt, endDt, activeSchedule.linked_session_key]
        );
        linkedSessionId = result.insertId;
      } else {
        linkedSessionId = linkedSessions[0].id;
      }

      await pool.query(
        `INSERT IGNORE INTO attendance_records (session_id, bank_code, student_name, floor_id, device_uuid, rssi, ble_token_used, is_late)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [linkedSessionId, bank_code, studentName, floorId, 'MANUAL', 0, 'LINKED_AUTO_MANUAL', false]
      );
    }

    // Call External Apps Script Webhook asynchronously
    if (process.env.APPS_SCRIPT_URL) {
      try {
        axios.post(process.env.APPS_SCRIPT_URL, {
          action: 'mark_attendance',
          bank_code: bank_code,
          floor_id: floorId,
          session_type: activeSessionType,
          timestamp: new Date().toISOString()
        }).catch(err => {
          console.error(`[WARN] Failed to trigger Apps Script: ${err.message}`);
        });
      } catch (err) {
        console.error(`[WARN] Failed to trigger Apps Script: ${err.message}`);
      }
    }

    return res.status(201).json({ success: true, message: 'Manual attendance marked successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/session/:id/records
// ------------------------------------------------------------
router.get('/session/:id/records', verifyFloorLeader, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT bank_code as student_code, student_name as name, rssi, marked_at
       FROM attendance_records
       WHERE session_id = ? AND floor_id = ?
       ORDER BY marked_at ASC`,
      [req.params.id, req.leader.floor_id]
    );
    return res.json({ success: true, records: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/attendance/gateway-sync
// ------------------------------------------------------------
router.post('/gateway-sync', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.GATEWAY_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized Gateway' });
    }

    const { student_id, device_id, floor_id, rssi, token } = req.body;
    if (!student_id || !device_id || !floor_id || !token) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const [students] = await pool.query('SELECT student_code, name FROM students WHERE name = ?', [student_id]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const bankCode = students[0].student_code;
    const studentName = students[0].name;

    const sessionDate = new Date().toISOString().slice(0, 10);
    const [sessions] = await pool.query(
      `SELECT id FROM attendance_sessions WHERE session_date = ?`,
      [sessionDate]
    );

    let activeSessionId;
    if (sessions.length === 0) {
      const [settingsRows] = await pool.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ("DAILY_START_TIME", "DAILY_END_TIME")');
      let startTimeStr = '21:00';
      let endTimeStr = '21:30';
      for (const row of settingsRows) {
        if (row.setting_key === 'DAILY_START_TIME') startTimeStr = row.setting_value;
        if (row.setting_key === 'DAILY_END_TIME') endTimeStr = row.setting_value;
      }

      const now = new Date();
      const [startH, startM] = startTimeStr.split(':').map(Number);
      const [endH, endM] = endTimeStr.split(':').map(Number);

      const startDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startH, startM, 0);
      const endDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), endH, endM, 0);

      const [result] = await pool.query(
        `INSERT INTO attendance_sessions (session_date, starts_at, ends_at)
         VALUES (?, ?, ?)`,
        [sessionDate, startDt, endDt]
      );
      activeSessionId = result.insertId;
    } else {
      activeSessionId = sessions[0].id;
    }

    try {
      await pool.query(
        `INSERT INTO attendance_records (session_id, bank_code, student_name, floor_id, device_uuid, rssi, ble_token_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [activeSessionId, bankCode, studentName, floor_id, device_id, rssi || -50, token]
      );
    } catch (dbErr) {
      if (dbErr.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, message: 'Already marked' });
      }
      throw dbErr;
    }

    return res.json({ success: true, message: 'Synced' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/live
// ------------------------------------------------------------
router.get('/live', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    let floorId = null;
    if (req.leader) {
      floorId = req.leader.floor_id;
    }

    let queryParams = [];
    const sessionDate = new Date().toISOString().slice(0, 10);

    let sessionsQuery = 'SELECT id FROM attendance_sessions WHERE session_date = ?';
    let sessionsParams = [sessionDate];

    if (floorId !== null) {
      sessionsQuery += ' AND floor_id = ?';
      sessionsParams.push(floorId);
    }

    const [sessions] = await pool.query(sessionsQuery, sessionsParams);

    if (sessions.length === 0) {
      return res.json({ success: true, records: [] });
    }

    const sessionIds = sessions.map(s => s.id);

    let recordsQuery = `
       SELECT ar.bank_code as student_code, ar.student_name as name, ar.rssi, ar.marked_at, f.floor_name
       FROM attendance_records ar
       LEFT JOIN floors f ON ar.floor_id = f.floor_id
       WHERE ar.session_id IN (?)
    `;
    let recordsParams = [sessionIds];

    if (floorId !== null) {
      recordsQuery += ' AND ar.floor_id = ?';
      recordsParams.push(floorId);
    }

    recordsQuery += ' ORDER BY ar.marked_at DESC';

    const [rows] = await pool.query(recordsQuery, recordsParams);

    return res.json({ success: true, records: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/export
// ------------------------------------------------------------
router.get('/export', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const sessionDate = req.query.date || new Date().toISOString().slice(0, 10);

    const query = `
       SELECT ar.bank_code as student_code, ar.student_name as name, f.floor_name, ar.marked_at
       FROM attendance_records ar
       LEFT JOIN floors f ON ar.floor_id = f.floor_id
       JOIN attendance_sessions ses ON ar.session_id = ses.id
       WHERE ses.session_date = ?
       ORDER BY ar.marked_at DESC
    `;

    const [rows] = await pool.query(query, [sessionDate]);

    const headers = ['Student Code', 'Name', 'Floor', 'Time Marked'];
    const csvRows = [headers.join(',')];

    for (const row of rows) {
      const dateStr = new Date(row.marked_at).toLocaleString();
      const name = `"${(row.name || '').replace(/"/g, '""')}"`;
      const floor = `"${(row.floor_name || '').replace(/"/g, '""')}"`;

      csvRows.push([row.student_code, name, floor, `"${dateStr}"`].join(','));
    }

    const csvData = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${sessionDate}.csv"`);

    return res.send(csvData);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error during export' });
  }
});

// ------------------------------------------------------------
// POST /api/attendance/mark-manual (and /manual-mark alias)
// ------------------------------------------------------------
const handleManualMark = async (req, res) => {
  try {
    const { student_code, student_id, bank_code, session_key, session_type, date, session_date, status, is_late, description, remarks } = req.body;
    const lookupCode = student_code || bank_code;
    const sKey = (session_key || session_type || 'night').toLowerCase();
    const sDate = session_date || date || getCurrentIST().toISOString().slice(0, 10);
    const lateFlag = is_late === true || is_late === 1 || String(status).toLowerCase() === 'late';
    const noteText = description || remarks || null;

    if (!lookupCode && !student_id) {
      return res.status(400).json({ success: false, message: 'Missing student identifier (student_code or student_id)' });
    }

    // 1. Find student
    let student = null;
    if (student_id) {
      const [rows] = await pool.query('SELECT id, student_code, name, floor_id, is_active FROM students WHERE id = ?', [student_id]);
      if (rows.length > 0) student = rows[0];
    }
    if (!student && lookupCode) {
      const [rows] = await pool.query(
        'SELECT id, student_code, name, floor_id, is_active FROM students WHERE student_code = ? OR CAST(student_code AS UNSIGNED) = CAST(? AS UNSIGNED)',
        [lookupCode, lookupCode]
      );
      if (rows.length > 0) student = rows[0];
    }

    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found in database' });
    }

    // 2. Find or create attendance session
    const [scheduleRows] = await pool.query(
      'SELECT session_key, start_time, end_time, linked_session_key FROM attendance_schedules WHERE session_key = ?',
      [sKey]
    );

    const now = getCurrentIST();
    let startDt = now;
    let endDt = now;

    if (scheduleRows.length > 0) {
      const [startH, startM] = (scheduleRows[0].start_time || '21:00').split(':').map(Number);
      const [endH, endM] = (scheduleRows[0].end_time || '21:30').split(':').map(Number);
      const y = parseInt(sDate.slice(0, 4), 10);
      const m = parseInt(sDate.slice(5, 7), 10) - 1;
      const d = parseInt(sDate.slice(8, 10), 10);
      startDt = new Date(Date.UTC(y, m, d, startH, startM, 0));
      endDt = new Date(Date.UTC(y, m, d, endH, endM, 0));
    }

    let [sessions] = await pool.query(
      'SELECT id FROM attendance_sessions WHERE session_date = ? AND LOWER(session_type) = LOWER(?)',
      [sDate, sKey]
    );

    let activeSessionId;
    if (sessions.length === 0) {
      const [insertSess] = await pool.query(
        'INSERT INTO attendance_sessions (session_date, starts_at, ends_at, session_type) VALUES (?, ?, ?, ?)',
        [sDate, startDt, endDt, sKey]
      );
      activeSessionId = insertSess.insertId;
    } else {
      activeSessionId = sessions[0].id;
    }

    // 3. Upsert attendance record
    const [existing] = await pool.query(
      'SELECT id FROM attendance_records WHERE session_id = ? AND (student_id = ? OR TRIM(LEADING "0" FROM bank_code) = TRIM(LEADING "0" FROM ?))',
      [activeSessionId, student.id, student.student_code]
    );

    if (existing.length > 0) {
      await pool.query(
        'UPDATE attendance_records SET is_late = ?, ble_token_used = "MANUAL_ENTRY", remarks = ?, marked_at = CURRENT_TIMESTAMP WHERE id = ?',
        [lateFlag ? 1 : 0, noteText, existing[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO attendance_records (session_id, bank_code, student_name, student_id, floor_id, device_uuid, rssi, ble_token_used, is_late, remarks)
         VALUES (?, ?, ?, ?, ?, 'MANUAL', 0, 'MANUAL_ENTRY', ?, ?)`,
        [activeSessionId, student.student_code, student.name, student.id, student.floor_id || 0, lateFlag ? 1 : 0, noteText]
      );
    }

    // 4. Handle Linked Session if configured
    if (scheduleRows.length > 0 && scheduleRows[0].linked_session_key) {
      const linkedKey = scheduleRows[0].linked_session_key;
      let [linkedSessions] = await pool.query(
        'SELECT id FROM attendance_sessions WHERE session_date = ? AND LOWER(session_type) = LOWER(?)',
        [sDate, linkedKey]
      );
      let linkedSessionId;
      if (linkedSessions.length === 0) {
        const [resLink] = await pool.query(
          'INSERT INTO attendance_sessions (session_date, starts_at, ends_at, session_type) VALUES (?, ?, ?, ?)',
          [sDate, startDt, endDt, linkedKey]
        );
        linkedSessionId = resLink.insertId;
      } else {
        linkedSessionId = linkedSessions[0].id;
      }

      await pool.query(
        `INSERT INTO attendance_records (session_id, bank_code, student_name, student_id, floor_id, device_uuid, rssi, ble_token_used, is_late, remarks)
         VALUES (?, ?, ?, ?, ?, 'MANUAL', 0, 'LINKED_AUTO_MANUAL', 0, 'Auto-marked from linked session')
         ON DUPLICATE KEY UPDATE is_late = 0`,
        [linkedSessionId, student.student_code, student.name, student.id, student.floor_id || 0]
      );
    }

    // 5. Clean up absent justification if it existed
    try {
      await pool.query(
        'DELETE FROM attendance_absent_reasons WHERE student_id = ? AND session_date = ? AND LOWER(session_type) = LOWER(?)',
        [student.id, sDate, sKey]
      );
    } catch (e) { }

    return res.status(200).json({
      success: true,
      message: `Manual attendance marked as ${lateFlag ? 'Late' : 'Present'} for ${student.name}`
    });
  } catch (err) {
    console.error('Error marking manual attendance:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
};

router.post('/mark-manual', verifyAdminOrFloorLeader, handleManualMark);
router.post('/manual-mark', verifyAdminOrFloorLeader, handleManualMark);

// ------------------------------------------------------------
// GET /api/attendance/session/:type/targets
// Fetch targets for a session (per floor or all)
// ------------------------------------------------------------
router.get('/session/:type/targets', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const sessionKey = req.params.type.toLowerCase();
    const floorId = req.query.floor_id;

    let query = 'SELECT floor_id, session_key, target_type, student_ids FROM floor_session_targets WHERE session_key = ?';
    const params = [sessionKey];

    if (floorId !== undefined && floorId !== 'All' && floorId !== 'ALL') {
      query += ' AND floor_id = ?';
      params.push(parseInt(floorId, 10));
    }

    const [rows] = await pool.query(query, params);

    const formatted = rows.map(r => {
      let sids = r.student_ids;
      if (typeof sids === 'string') {
        try { sids = JSON.parse(sids); } catch (e) { sids = []; }
      }
      return {
        floor_id: r.floor_id,
        session_key: r.session_key,
        target_type: r.target_type,
        student_ids: Array.isArray(sids) ? sids : []
      };
    });

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error fetching session targets:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/attendance/session/:type/targets
// Save student target assignments for a session on a floor
// ------------------------------------------------------------
router.post('/session/:type/targets', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const sessionKey = req.params.type.toLowerCase();
    const { floor_id, target_type, student_ids } = req.body;

    if (floor_id === undefined) {
      return res.status(400).json({ success: false, message: 'floor_id is required' });
    }

    const tType = target_type === 'ALL' ? 'ALL' : 'SELECTED';
    const sidsJson = JSON.stringify(Array.isArray(student_ids) ? student_ids : []);

    await pool.query(`
      INSERT INTO floor_session_targets (floor_id, session_key, target_type, student_ids)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE target_type = VALUES(target_type), student_ids = VALUES(student_ids)
    `, [parseInt(floor_id, 10), sessionKey, tType, sidsJson]);

    return res.json({ success: true, message: 'Session student targets updated successfully' });
  } catch (err) {
    console.error('Error updating session targets:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/session/:type/students
// ------------------------------------------------------------
router.get('/session/:type/students', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const sessionType = req.params.type.toLowerCase();
    const sessionDate = req.query.date || new Date().toISOString().slice(0, 10);

    // Check if session is for all students
    const [scheduleRows] = await pool.query('SELECT is_for_all_students FROM attendance_schedules WHERE session_key = ?', [sessionType]);
    const isForAll = scheduleRows.length === 0 || scheduleRows[0].is_for_all_students === 1 || scheduleRows[0].is_for_all_students === true;

    let floorCondition = '';
    let targetCondition = '';
    let params = [sessionDate, sessionType, sessionDate, sessionType];

    if (req.leader) {
      const leaderFloors = Array.isArray(req.leader.assigned_floors) && req.leader.assigned_floors.length > 0
        ? req.leader.assigned_floors.map(f => parseInt(f, 10))
        : (req.leader.floor_id !== undefined ? [parseInt(req.leader.floor_id, 10)] : []);
      if (leaderFloors.length > 0) {
        floorCondition = 'AND s.floor_id IN (?)';
        params.push(leaderFloors);
      }
    }

    if (!isForAll) {
      const [targetRows] = await pool.query('SELECT student_ids FROM floor_session_targets WHERE session_key = ? AND target_type = "SELECTED"', [sessionType]);
      let assignedStudentIds = [];
      for (const tr of targetRows) {
        let sids = tr.student_ids;
        if (typeof sids === 'string') {
          try { sids = JSON.parse(sids); } catch (e) { sids = []; }
        }
        if (Array.isArray(sids)) {
          assignedStudentIds.push(...sids.map(id => String(id).trim()));
        }
      }

      if (assignedStudentIds.length === 0) {
        return res.json({ success: true, data: [] });
      }

      targetCondition = 'AND (s.id IN (?) OR s.student_code IN (?) OR TRIM(LEADING "0" FROM s.student_code) IN (?))';
      params.push(assignedStudentIds, assignedStudentIds, assignedStudentIds);
    }

    const query = `
      SELECT s.id as student_id, s.student_code, s.name, s.floor_id, s.room_number,
             ar.marked_at, 
             IF(ar.session_id IS NULL, false, true) as is_present,
             ar.is_late,
             ar.remarks as attendance_remarks,
             aar.reason as absent_reason,
             aar.is_justified
      FROM students s
      LEFT JOIN attendance_sessions ses ON ses.session_date = ? AND LOWER(ses.session_type) = LOWER(?)
      LEFT JOIN attendance_records ar ON (s.student_code = ar.bank_code OR s.id = ar.student_id) AND ar.session_id = ses.id
      LEFT JOIN attendance_absent_reasons aar ON s.id = aar.student_id AND aar.session_date = ? AND LOWER(aar.session_type) = LOWER(?)
      WHERE s.is_active = TRUE ${floorCondition} ${targetCondition}
      ORDER BY s.name ASC
    `;

    const [rows] = await pool.query(query, params);

    // Fetch tags for these students
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

    const formattedRows = rows.map(r => {
      const isPresent = Boolean(r.is_present && r.is_present !== 0 && r.is_present !== '0');
      const isLate = Boolean(r.is_late && r.is_late !== 0 && r.is_late !== '0');
      const status = isPresent ? (isLate ? 'Late' : 'Present') : 'Absent';
      return {
        ...r,
        status,
        reason: r.absent_reason || null,
        remarks: r.attendance_remarks || null,
        tags: tagsMap[r.student_id] || []
      };
    });

    return res.json({ success: true, data: formattedRows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error fetching student attendance' });
  }
});

// ------------------------------------------------------------
// GET /api/attendance/session/:type/absent-reasons
// ------------------------------------------------------------
router.get('/session/:type/absent-reasons', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const sessionType = req.params.type.toLowerCase();
    const sessionDate = req.query.date || new Date().toISOString().slice(0, 10);

    // Check if session is for all students
    const [scheduleRows] = await pool.query('SELECT is_for_all_students FROM attendance_schedules WHERE session_key = ?', [sessionType]);
    const isForAll = scheduleRows.length === 0 || scheduleRows[0].is_for_all_students === 1 || scheduleRows[0].is_for_all_students === true;

    let floorCondition = '';
    let targetCondition = '';
    let params = [sessionDate, sessionType, sessionDate, sessionType];

    if (req.leader) {
      const leaderFloors = Array.isArray(req.leader.assigned_floors) && req.leader.assigned_floors.length > 0
        ? req.leader.assigned_floors.map(f => parseInt(f, 10))
        : (req.leader.floor_id !== undefined ? [parseInt(req.leader.floor_id, 10)] : []);
      if (leaderFloors.length > 0) {
        floorCondition = 'AND s.floor_id IN (?)';
        params.push(leaderFloors);
      }
    }

    if (!isForAll) {
      const [targetRows] = await pool.query('SELECT student_ids FROM floor_session_targets WHERE session_key = ? AND target_type = "SELECTED"', [sessionType]);
      let assignedStudentIds = [];
      for (const tr of targetRows) {
        let sids = tr.student_ids;
        if (typeof sids === 'string') {
          try { sids = JSON.parse(sids); } catch (e) { sids = []; }
        }
        if (Array.isArray(sids)) {
          assignedStudentIds.push(...sids.map(id => String(id).trim()));
        }
      }

      if (assignedStudentIds.length === 0) {
        return res.json({ success: true, data: [] });
      }

      targetCondition = 'AND (s.id IN (?) OR s.student_code IN (?) OR TRIM(LEADING "0" FROM s.student_code) IN (?))';
      params.push(assignedStudentIds, assignedStudentIds, assignedStudentIds);
    }

    const query = `
      SELECT s.id as student_id, s.student_code, s.name, s.floor_id, s.room_number,
             aar.reason,
             aar.is_justified
      FROM students s
      LEFT JOIN attendance_sessions ses ON ses.session_date = ? AND LOWER(ses.session_type) = LOWER(?)
      LEFT JOIN attendance_records ar ON (s.student_code = ar.bank_code OR s.id = ar.student_id) AND ar.session_id = ses.id
      LEFT JOIN attendance_absent_reasons aar ON s.id = aar.student_id AND aar.session_date = ? AND LOWER(aar.session_type) = LOWER(?)
      WHERE s.is_active = TRUE AND ar.id IS NULL ${floorCondition} ${targetCondition}
      ORDER BY s.name ASC
    `;

    const [rows] = await pool.query(query, params);

    // Fetch tags
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

    const enrichedRows = rows.map(r => ({
      ...r,
      tags: tagsMap[r.student_id] || []
    }));

    return res.json({ success: true, data: enrichedRows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error fetching absent records' });
  }
});

router.post('/session/absent-reason', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const { student_id, student_code, session_type, session_key, session_date, date, dates, reason, description, is_justified } = req.body;
    const sKey = (session_key || session_type || 'night').toLowerCase();
    const reasonText = (reason || description || '').trim();

    if (!reasonText) {
      return res.status(400).json({ success: false, message: 'Description is required' });
    }

    let sid = student_id;
    if (!sid && student_code) {
      const [stuRows] = await pool.query('SELECT id FROM students WHERE student_code = ?', [student_code]);
      if (stuRows.length > 0) sid = stuRows[0].id;
    }

    if (!sid) {
      return res.status(400).json({ success: false, message: 'Student ID not found' });
    }

    const targetDates = Array.isArray(dates) && dates.length > 0 ? dates : [session_date || date || getCurrentIST().toISOString().slice(0, 10)];

    // Insert or update the reason for each date
    const query = `
      INSERT INTO attendance_absent_reasons (session_date, session_type, student_id, reason, is_justified)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE reason = VALUES(reason), is_justified = VALUES(is_justified), created_at = CURRENT_TIMESTAMP
    `;

    for (const d of targetDates) {
      await pool.query(query, [d, sKey, sid, reasonText, is_justified !== false ? 1 : 0]);
    }

    return res.json({ success: true, message: 'Absence justification saved successfully' });
  } catch (err) {
    console.error('Error saving absent reason:', err);
    return res.status(500).json({ success: false, message: 'Server error saving reason: ' + (err.sqlMessage || err.message) });
  }
});

// removed request-token

export default router;
module.exports = router;
