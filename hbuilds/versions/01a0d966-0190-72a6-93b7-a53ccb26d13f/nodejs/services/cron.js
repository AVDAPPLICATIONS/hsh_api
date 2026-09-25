const cron = require('node-cron');
const pool = require('../config/db');
const admin = require('../config/firebase');
const { getCurrentIST } = require('../utils/time');
const { sendMessage } = require('./whatsapp');

async function sendPushNotification(tokens, title, body) {
  if (!tokens || tokens.length === 0) return;
  
  const message = {
    notification: { title, body },
    tokens: tokens,
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
  return rows.map(r => r.fcm_token).filter(t => t);
}

async function getAllStudentTokens() {
  const query = `SELECT fcm_token FROM students WHERE fcm_token IS NOT NULL`;
  const [rows] = await pool.query(query);
  return rows.map(r => r.fcm_token).filter(t => t);
}

// Run every minute at 0 seconds
cron.schedule('* * * * *', async () => {
  try {
    const [schedules] = await pool.query(
      'SELECT session_key, session_name, start_time, end_time, auto_message, auto_message_student, auto_message_parent, auto_message_time, auto_message_audience, is_for_all_students FROM attendance_schedules WHERE is_active = TRUE'
    );
    
    const now = getCurrentIST();
    now.setUTCSeconds(0, 0); // Strip seconds
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

      // Handle cross-midnight (e.g. 21:00 to 06:00)
      if (startDt.getTime() > endDt.getTime()) {
        if (now.getUTCHours() < 12) {
           // We are in the morning part of the shift, so start was yesterday
           startDt.setUTCDate(startDt.getUTCDate() - 1);
        } else {
           // We are in the evening part of the shift, so end is tomorrow
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
        
        // Handle cross-midnight for auto-message time
        if (startDt.getTime() > endDt.getTime() && now.getUTCHours() > 12 && amH < 12) {
          amDt.setUTCDate(amDt.getUTCDate() + 1);
        }

        const lastSentDate = schedule.last_auto_message_date ? new Date(schedule.last_auto_message_date).toISOString().slice(0, 10) : null;

        if (nowTime === amDt.getTime() && lastSentDate !== sessionDate) {
          console.log(`[Cron] Triggering Auto-Message for absent students/parents in ${sessionName}...`);
          try {
            await pool.query('UPDATE attendance_schedules SET last_auto_message_date = ? WHERE session_key = ?', [sessionDate, schedule.session_key]);

            const isForAll = schedule.is_for_all_students === 1 || schedule.is_for_all_students === true || schedule.is_for_all_students === null || schedule.is_for_all_students === undefined;

            let targetFilterClause = '';
            const targetFilterParams = [sessionDate, schedule.session_key];

            if (!isForAll) {
              const [targetRows] = await pool.query('SELECT student_ids FROM floor_session_targets WHERE session_key = ? AND target_type = "SELECTED"', [schedule.session_key]);
              let assignedStudentIds = [];
              for (const tr of targetRows) {
                let sids = tr.student_ids;
                if (typeof sids === 'string') {
                  try { sids = JSON.parse(sids); } catch(e) { sids = []; }
                }
                if (Array.isArray(sids)) {
                  assignedStudentIds.push(...sids.map(id => String(id).trim()));
                }
              }

              if (assignedStudentIds.length === 0) {
                console.log(`[Cron] No students assigned to selective session ${sessionName}. Skipping absent messages.`);
                continue;
              }

              targetFilterClause = 'AND (s.id IN (?) OR s.student_code IN (?) OR TRIM(LEADING "0" FROM s.student_code) IN (?))';
              targetFilterParams.push(assignedStudentIds, assignedStudentIds, assignedStudentIds);
            }

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

            console.log(`[Cron] Found ${targetStudents.length} absent students to notify for ${sessionName}`);

            const formatMsg = (tpl, student) => {
              let msg = tpl;
              msg = msg.replace(/{name}/gi, student.name || 'Student');
              msg = msg.replace(/{student_name}/gi, student.name || 'Student');
              msg = msg.replace(/{session_name}/gi, schedule.session_name || sessionName);
              msg = msg.replace(/{date}/gi, sessionDate);
              msg = msg.replace(/{room}/gi, student.roomNumber || 'N/A');
              msg = msg.replace(/{room number}/gi, student.roomNumber || 'N/A');
              msg = msg.replace(/{floor}/gi, student.floorId !== undefined ? `Floor ${student.floorId}` : '');
              msg = msg.replace(/{student_phone}/gi, student.phone || '');
              msg = msg.replace(/{parent_phone}/gi, student.parentPhone || student.fatherPhone || '');
              return msg;
            };

            for (const student of targetStudents) {
              // 1. Send to Student if student template is configured
              if (studentTpl && student.phone) {
                const sMsg = formatMsg(studentTpl, student);
                try {
                  await sendMessage(student.phone, sMsg);
                  console.log(`[Cron] Sent absent alert to student ${student.name} (${student.phone})`);
                } catch (waErr) {
                  console.error(`[Cron] Failed to send student auto-message to ${student.phone}:`, waErr.message);
                }
                await new Promise(resolve => setTimeout(resolve, 1200 + Math.random() * 800));
              }

              // 2. Send to Parent if parent template is configured
              const parentDestination = student.parentPhone || student.fatherPhone || student.motherPhone;
              if (parentTpl && parentDestination) {
                const pMsg = formatMsg(parentTpl, student);
                try {
                  await sendMessage(parentDestination, pMsg);
                  console.log(`[Cron] Sent absent alert for ${student.name} to parent (${parentDestination})`);
                } catch (waErr) {
                  console.error(`[Cron] Failed to send parent auto-message to ${parentDestination}:`, waErr.message);
                }
                await new Promise(resolve => setTimeout(resolve, 1200 + Math.random() * 800));
              }
            }
          } catch(e) {
            console.error(`[Cron] Error executing Auto-Message for ${sessionName}:`, e);
          }
        }
      }

      // Auto-mark default attendance students if session window is active
      if (nowTime >= startTimeMs && nowTime <= endTimeMs) {
        try {
          let [sessions] = await pool.query(
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
              } catch(e) {}
            }
          }
        } catch(autoErr) {
          console.error(`[Cron] Error auto-marking default attendance for ${sessionName}:`, autoErr.message);
        }
      }

      // 1. At Start Time
      if (nowTime === startTimeMs) {
        console.log(`[Cron] ${sessionName} Attendance window started.`);
        const tokens = await getAllStudentTokens();
        await sendPushNotification(tokens, `${sessionName} Attendance Started! ⏰`, "The attendance window is now open. Please mark your attendance.");
      }

      // 2. At End Time
      if (nowTime === endTimeMs) {
        // Clear tokens for all floors
        await pool.query('UPDATE floors SET current_token = NULL');
        console.log(`[Cron] Cleared attendance tokens for all floors (${sessionName} ended).`);

        const tokens = await getAllStudentTokens();
        await sendPushNotification(tokens, `${sessionName} Attendance Closed 🔒`, "The attendance window has ended.");
      }

      // 3. 10 Minutes before End Time
      if (nowTime === tenMinsBeforeEndMs) {
        const tokens = await getUnmarkedStudentTokens(schedule.session_key, sessionDate);
        await sendPushNotification(tokens, "Only 10 minutes left! ⏳", `${sessionName} attendance closes soon. Go and mark your attendance now!`);
      }

      // 4. Every 10 Minutes between start and 10-minutes-before-end
      if (nowTime > startTimeMs && nowTime < tenMinsBeforeEndMs) {
        const diffMinutes = Math.floor((nowTime - startTimeMs) / 60000);
        if (diffMinutes > 0 && diffMinutes % 10 === 0) {
          const tokens = await getUnmarkedStudentTokens(schedule.session_key, sessionDate);
          await sendPushNotification(tokens, "Reminder: Mark Attendance ⚠️", `You haven't marked your ${schedule.session_key} attendance yet. Go and do your attendance!`);
        }
      }
    }
  } catch (err) {
    console.error('Error in cron job:', err);
  }
});

// ------------------------------------------------------------
// Weekly Gemini AI Tag Analysis (Every Sunday at 23:59 IST)
// Analyzes last 20 days attendance data for each student
// ------------------------------------------------------------
const { runAiTagAnalysis } = require('./geminiTagger');

cron.schedule('59 23 * * 0', async () => {
  console.log('[Cron] Triggering Scheduled Weekly Gemini AI Student Tag Analysis (Last 20 Days)...');
  try {
    const result = await runAiTagAnalysis({ floorId: null, batchSize: 25 });
    console.log('[Cron] Weekly Gemini AI Student Tag Analysis completed successfully:', result.message);
  } catch (err) {
    console.error('[Cron] Error during weekly Gemini AI tag analysis:', err.message);
  }
});

console.log('Push notification & Gemini AI cron service started.');

