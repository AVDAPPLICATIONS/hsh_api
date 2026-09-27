import cron from 'node-cron';
import pool from '../config/db';
import admin from '../config/firebase';
import { getCurrentIST } from '../utils/time';
import { sendMessage } from './whatsapp';
import { runAiTagAnalysis } from './geminiTagger';

async function sendPushNotification(tokens, title, body) {
  if (!tokens || tokens.length === 0) return;

  const message = {
    notification: { title, body },
    tokens: tokens
  };

  try {
    const response = await admin.messaging().sendMulticast(message);
    console.log(`Cron Push Notification sent: ${response.successCount} successes`);
  } catch (error) {
    console.error('Error sending cron push notifications:', error);
  }
}

async function getUnmarkedStudentTokens(sessionType, sessionDate) {
  const query = `
    SELECT s.fcm_token 
    FROM students s
    WHERE s.fcm_token IS NOT NULL 
    AND TRIM(LEADING '0' FROM s.student_code) NOT IN (
      SELECT TRIM(LEADING '0' FROM r.bank_code) 
      FROM attendance_records r
      JOIN attendance_sessions ses ON r.session_id = ses.id
      WHERE ses.session_date = ? AND ses.session_type = ?
    )
  `;
  const [rows] = await pool.query(query, [sessionDate, sessionType]);
  return rows.map((r) => r.fcm_token).filter(Boolean);
}

async function getAllStudentTokens() {
  const query = 'SELECT fcm_token FROM students WHERE fcm_token IS NOT NULL';
  const [rows] = await pool.query(query);
  return rows.map((r) => r.fcm_token).filter(Boolean);
}

// ------------------------------------------------------------
// 1. Attendance & Session Windows (Runs every minute)
// ------------------------------------------------------------
cron.schedule('* * * * *', async () => {
  try {
    const [schedules] = await pool.query(
      'SELECT session_key, session_name, start_time, end_time, auto_message, auto_message_student, auto_message_parent, auto_message_time, auto_message_audience, is_for_all_students FROM attendance_schedules WHERE is_active = TRUE'
    );

    const now = getCurrentIST();
    now.setUTCSeconds(0, 0);
    const nowTime = now.getTime();
    const sessionDate = now.toISOString().slice(0, 10);

    for (const schedule of schedules) {
      if (schedule.start_time === schedule.end_time) {
        continue;
      }

      const [startH, startM] = schedule.start_time.split(':').map(Number);
      const [endH, endM] = schedule.end_time.split(':').map(Number);

      let startDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), startH, startM, 0));
      let endDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endH, endM, 0));

      if (startDt.getTime() > endDt.getTime()) {
        if (now.getUTCHours() < 12) {
          startDt.setUTCDate(startDt.getUTCDate() - 1);
        } else {
          endDt.setUTCDate(endDt.getUTCDate() + 1);
        }
      }

      const startTimeMs = startDt.getTime();
      const endTimeMs = endDt.getTime();
      const tenMinsBeforeEndMs = endTimeMs - (10 * 60000);
      const sessionName = schedule.session_key.charAt(0).toUpperCase() + schedule.session_key.slice(1);

      const studentTpl = (schedule.auto_message_student || schedule.auto_message || '').trim();
      const parentTpl = (schedule.auto_message_parent || '').trim();

      // Auto-Message Logic for Absent Students
      if ((studentTpl || parentTpl) && schedule.auto_message_time) {
        const [amH, amM] = schedule.auto_message_time.split(':').map(Number);
        let amDt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), amH, amM, 0));

        if (startDt.getTime() > endDt.getTime() && now.getUTCHours() > 12 && amH < 12) {
          amDt.setUTCDate(amDt.getUTCDate() + 1);
        }

        const lastSentDate = schedule.last_auto_message_date ? new Date(schedule.last_auto_message_date).toISOString().slice(0, 10) : null;

        if (nowTime === amDt.getTime() && lastSentDate !== sessionDate) {
          try {
            await pool.query('UPDATE attendance_schedules SET last_auto_message_date = ? WHERE session_key = ?', [sessionDate, schedule.session_key]);

            const isForAll = schedule.is_for_all_students === 1 || schedule.is_for_all_students === true || schedule.is_for_all_students === null;
            let targetFilterClause = '';
            const targetFilterParams = [sessionDate, schedule.session_key];

            if (!isForAll) {
              const [targetRows] = await pool.query(
                'SELECT student_ids FROM floor_session_targets WHERE session_key = ? AND target_type = "SELECTED"',
                [schedule.session_key]
              );
              let assignedStudentIds = [];
              for (const tr of targetRows) {
                let sids = tr.student_ids;
                if (typeof sids === 'string') {
                  try { sids = JSON.parse(sids); } catch (e) { sids = []; }
                }
                if (Array.isArray(sids)) {
                  assignedStudentIds.push(...sids.map((id) => String(id).trim()));
                }
              }

              if (assignedStudentIds.length === 0) continue;
              targetFilterClause = 'AND (s.id IN (?) OR s.student_code IN (?) OR TRIM(LEADING "0" FROM s.student_code) IN (?))';
              targetFilterParams.push(assignedStudentIds, assignedStudentIds, assignedStudentIds);
            }

            const query = `
              SELECT 
                s.phone_number AS phone, 
                s.father_phone AS fatherPhone,
                s.mother_phone AS motherPhone,
                s.parent_phone AS parentPhone,
                s.name, 
                s.student_code AS bankCode, 
                s.room_number AS roomNumber, 
                s.floor_id AS floorId
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

            const formatMsg = (tpl, student) => {
              let msg = tpl;
              msg = msg.replace(/{name}/gi, student.name || 'Student');
              msg = msg.replace(/{student_name}/gi, student.name || 'Student');
              msg = msg.replace(/{session_name}/gi, schedule.session_name || sessionName);
              msg = msg.replace(/{date}/gi, sessionDate);
              msg = msg.replace(/{room}/gi, student.roomNumber || 'N/A');
              msg = msg.replace(/{floor}/gi, student.floorId !== undefined ? `Floor ${student.floorId}` : '');
              msg = msg.replace(/{student_phone}/gi, student.phone || '');
              msg = msg.replace(/{parent_phone}/gi, student.parentPhone || student.fatherPhone || '');
              return msg;
            };

            for (const student of targetStudents) {
              if (studentTpl && student.phone) {
                const sMsg = formatMsg(studentTpl, student);
                try {
                  await sendMessage(student.phone, sMsg);
                } catch (waErr) {
                  console.error(`[Cron] WA student alert failed for ${student.phone}:`, waErr.message);
                }
                await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
              }

              const parentDestination = student.parentPhone || student.fatherPhone || student.motherPhone;
              if (parentTpl && parentDestination) {
                const pMsg = formatMsg(parentTpl, student);
                try {
                  await sendMessage(parentDestination, pMsg);
                } catch (waErr) {
                  console.error(`[Cron] WA parent alert failed for ${parentDestination}:`, waErr.message);
                }
                await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
              }
            }
          } catch (e) {
            console.error(`[Cron] Error executing Auto-Message for ${sessionName}:`, e);
          }
        }
      }

      // Auto-mark default attendance students if session window is active
      if (nowTime >= startTimeMs && nowTime <= endTimeMs) {
        try {
          const [sessions] = await pool.query(
            'SELECT id FROM attendance_sessions WHERE session_date = ? AND LOWER(session_type) = LOWER(?)',
            [sessionDate, schedule.session_key]
          );

          let activeSessionId;
          if (sessions.length === 0) {
            const [insertSess] = await pool.query(
              'INSERT INTO attendance_sessions (session_date, starts_at, ends_at, session_type) VALUES (?, ?, ?, ?)',
              [sessionDate, startDt, endDt, schedule.session_key]
            );
            activeSessionId = insertSess.insertId;
          } else {
            activeSessionId = sessions[0].id;
          }

          const [defaultStudents] = await pool.query(
            'SELECT id, student_code, name, floor_id FROM students WHERE is_active = TRUE AND is_default_present = TRUE'
          );

          for (const st of defaultStudents) {
            const [existing] = await pool.query(
              'SELECT id FROM attendance_records WHERE session_id = ? AND (student_id = ? OR TRIM(LEADING "0" FROM bank_code) = TRIM(LEADING "0" FROM ?))',
              [activeSessionId, st.id, st.student_code]
            );

            if (existing.length === 0) {
              await pool.query(
                `INSERT INTO attendance_records (session_id, bank_code, student_name, student_id, floor_id, device_uuid, rssi, ble_token_used, is_late, remarks)
                 VALUES (?, ?, ?, ?, ?, 'AUTO_DEFAULT', 0, 'DEFAULT_AUTO_PRESENT', 0, 'Auto-marked as Default Present')`,
                [activeSessionId, st.student_code, st.name, st.id, st.floor_id || 0]
              );

              try {
                await pool.query(
                  'DELETE FROM attendance_absent_reasons WHERE student_id = ? AND session_date = ? AND LOWER(session_type) = LOWER(?)',
                  [st.id, sessionDate, schedule.session_key]
                );
              } catch (e) {}
            }
          }
        } catch (autoErr) {
          console.error(`[Cron] Error auto-marking default attendance for ${sessionName}:`, autoErr.message);
        }
      }

      // Notifications at start, end, and 10 mins before end
      if (nowTime === startTimeMs) {
        const tokens = await getAllStudentTokens();
        await sendPushNotification(tokens, `${sessionName} Attendance Started! ⏰`, 'The attendance window is now open. Please mark your attendance.');
      }

      if (nowTime === endTimeMs) {
        await pool.query('UPDATE floors SET current_token = NULL');
        const tokens = await getAllStudentTokens();
        await sendPushNotification(tokens, `${sessionName} Attendance Closed 🔒`, 'The attendance window has ended.');
      }

      if (nowTime === tenMinsBeforeEndMs) {
        const tokens = await getUnmarkedStudentTokens(schedule.session_key, sessionDate);
        await sendPushNotification(tokens, 'Only 10 minutes left! ⏳', `${sessionName} attendance closes soon. Go and mark your attendance now!`);
      }
    }
  } catch (err) {
    console.error('Error in attendance cron job:', err);
  }
});

// ------------------------------------------------------------
// 2. Complaint 24-Hour Feedback & Category Lockout Sweep (Runs every 10 minutes)
// ------------------------------------------------------------
cron.schedule('*/10 * * * *', async () => {
  try {
    const [staleComplaints] = await pool.query(`
      SELECT c.*, s.name AS student_name
      FROM complains c
      JOIN students s ON c.student_id = s.id
      WHERE c.status = 'solved' 
        AND c.solvedTime < NOW() - INTERVAL 24 HOUR
    `);

    for (const ticket of staleComplaints) {
      // 1. Lock category for the student
      await pool.query(`
        INSERT INTO student_category_locks (student_id, category, locked_reason, is_locked)
        VALUES (?, ?, 'Failed to provide resolution feedback within 24 hours of solver completion', TRUE)
        ON DUPLICATE KEY UPDATE is_locked = TRUE, locked_at = NOW()
      `, [ticket.student_id, ticket.compType]);

      // 2. Archive to complains_archive
      await pool.query(`
        INSERT INTO complains_archive 
          (id, student_id, room, compType, compDesc, images, status, assigned_solver_id, solver_response, student_feedback, student_rating, submitTime, solvedTime, archivedTime)
        VALUES 
          (?, ?, ?, ?, ?, ?, 'auto_closed', ?, ?, 'Auto-closed after 24h of student inaction', NULL, ?, ?, NOW())
      `, [
        ticket.id, ticket.student_id, ticket.room, ticket.compType, ticket.compDesc,
        ticket.images, ticket.assigned_solver_id, ticket.solver_response,
        ticket.submitTime, ticket.solvedTime
      ]);

      // 3. Purge from active complains table
      await pool.query('DELETE FROM complains WHERE id = ?', [ticket.id]);

      console.log(`[Complaint Cron] Auto-closed complaint #${ticket.id} and locked category "${ticket.compType}" for student ${ticket.student_name} (#${ticket.student_id})`);
    }
  } catch (cronErr) {
    console.error('[Complaint Cron] Error during 24h lockout sweep:', cronErr);
  }
});

// ------------------------------------------------------------
// 3. Weekly Gemini AI Tag Analysis (Every Sunday at 23:59 IST)
// ------------------------------------------------------------
cron.schedule('59 23 * * 0', async () => {
  console.log('[Cron] Triggering Scheduled Weekly Gemini AI Student Tag Analysis (Last 20 Days)...');
  try {
    const result = await runAiTagAnalysis({ floorId: null, batchSize: 25 });
    console.log('[Cron] Weekly Gemini AI Student Tag Analysis completed successfully:', result.message);
  } catch (err) {
    console.error('[Cron] Error during weekly Gemini AI tag analysis:', err.message);
  }
});

console.log('Push notification, Complaint 24h lockout & Gemini AI cron services initialized.');

export default {};
