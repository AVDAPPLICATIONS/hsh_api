import https from 'https';
import pool from '../config/db';

const GEMINI_API_KEYS = [
  'AQ.Ab8RN6LRazDitAQspknrVSVlhWQS3NFmuIk6VH3cXq6tLqivyA',
  'AQ.Ab8RN6LnpAeetY0ymbv6UME4my6yAXmxeOccp7fYeKi2Qq8vCw',
  'AQ.Ab8RN6J05SaB7nUWSs9JDifWAC0LVgXU1l72t3Sx0TaY-uG6yQ'
];

/**
 * Call Google Gemini REST API with key rotation and fallback models
 */
export async function callGemini(promptText: string): Promise<any> {
  const models = [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3-flash-preview'
  ];

  const postData = JSON.stringify({
    contents: [
      {
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  });

  for (const currentKey of GEMINI_API_KEYS) {
    for (const model of models) {
      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          const response: any = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: 'generativelanguage.googleapis.com',
              path: `/v1beta/models/${model}:generateContent?key=${currentKey}`,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
              },
              timeout: 25000
            }, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
            });

            req.on('error', reject);
            req.on('timeout', () => {
              req.destroy();
              reject(new Error('Gemini API timeout'));
            });
            req.write(postData);
            req.end();
          });

          if (response.statusCode === 200) {
            const parsed = JSON.parse(response.body);
            const rawText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (rawText) {
              return JSON.parse(rawText);
            }
          } else if (response.statusCode === 429 || response.statusCode === 403 || response.statusCode === 503) {
            console.warn(`[Gemini AI] Key/Model (${model}) returned status ${response.statusCode}. Switching to next key/model...`);
            break;
          }
        } catch (err: any) {
          console.warn(`[Gemini AI] Call error on key/model ${model} (attempt ${attempt}):`, err.message);
        }
      }
    }
  }

  throw new Error('All Gemini API keys and models failed or timed out.');
}

/**
 * Ensures system tags (Regular, Irregular, Late) exist and are up to date
 */
export async function ensureSystemTags(): Promise<Record<string, number>> {
  await pool.query(`
    UPDATE student_tags 
    SET name = 'Late', description = 'Comes late to attendance' 
    WHERE name = 'Late 3+ Days'
  `);

  const systemTags = [
    { name: 'Regular', color: '#10b981', description: 'Consistent daily attendance (>=75%)' },
    { name: 'Irregular', color: '#f59e0b', description: 'Inconsistent attendance / frequent absences' },
    { name: 'Late', color: '#ef4444', description: 'Comes late to attendance' }
  ];

  for (const st of systemTags) {
    await pool.query(`
      INSERT INTO student_tags (name, color, is_system, description)
      VALUES (?, ?, TRUE, ?)
      ON DUPLICATE KEY UPDATE color = VALUES(color), description = VALUES(description), is_system = TRUE
    `, [st.name, st.color, st.description]);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_tag_analysis_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      assigned_tag VARCHAR(50) NOT NULL,
      reason TEXT,
      analyzed_days INT DEFAULT 20,
      analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX (student_id),
      INDEX (analyzed_at)
    )
  `);

  const [tagRows]: any = await pool.query('SELECT id, name FROM student_tags WHERE name IN ("Regular", "Irregular", "Late")');
  const tagMap: Record<string, number> = {};
  for (const r of tagRows) {
    tagMap[r.name] = r.id;
  }
  return tagMap;
}

/**
 * Gather last 20 days attendance data for students
 */
async function getStudent20DayStats(studentIds: number[]): Promise<Record<number, any>> {
  if (!studentIds || studentIds.length === 0) return {};

  const [sessions]: any = await pool.query(`
    SELECT id, session_date, session_type
    FROM attendance_sessions
    WHERE session_date >= DATE_SUB(CURDATE(), INTERVAL 20 DAY)
    ORDER BY session_date DESC, id DESC
  `);

  const sessionIds = sessions.map((s: any) => s.id);
  if (sessionIds.length === 0) {
    const emptyStats: Record<number, any> = {};
    for (const sid of studentIds) {
      emptyStats[sid] = { totalSessions: 0, attended: 0, late: 0, onTime: 0, absent: 0, recentDays: [] };
    }
    return emptyStats;
  }

  const [records]: any = await pool.query(`
    SELECT ar.student_id, ar.bank_code, ar.session_id, ar.is_late, ar.marked_at, ses.session_date, ses.session_type
    FROM attendance_records ar
    JOIN attendance_sessions ses ON ar.session_id = ses.id
    WHERE ses.id IN (?)
  `, [sessionIds]);

  const statsMap: Record<number, any> = {};
  for (const sid of studentIds) {
    statsMap[sid] = {
      totalSessions: sessions.length,
      attended: 0,
      late: 0,
      onTime: 0,
      absent: 0,
      recentDays: []
    };
  }

  for (const sid of studentIds) {
    const sRecords = records.filter((r: any) => r.student_id === sid);

    statsMap[sid].attended = sRecords.length;
    statsMap[sid].late = sRecords.filter((r: any) => r.is_late).length;
    statsMap[sid].onTime = sRecords.filter((r: any) => !r.is_late).length;
    statsMap[sid].absent = Math.max(0, sessions.length - sRecords.length);

    for (const ses of sessions.slice(0, 5)) {
      const rec = sRecords.find((r: any) => r.session_id === ses.id);
      if (rec) {
        statsMap[sid].recentDays.push(rec.is_late ? 'LATE' : 'ON_TIME');
      } else {
        statsMap[sid].recentDays.push('ABSENT');
      }
    }
  }

  return statsMap;
}

/**
 * Main function to run AI Tag Analysis for all students or specific floor
 */
export async function runAiTagAnalysis({ floorId = null, batchSize = 25 }: { floorId?: number | null; batchSize?: number } = {}): Promise<any> {
  console.log(`[Gemini AI] Starting 20-day attendance tag analysis... (Floor: ${floorId || 'ALL'})`);

  const tagMap = await ensureSystemTags();
  const systemTagIds = Object.values(tagMap);

  let query = 'SELECT id, student_code, name, floor_id, room_number FROM students WHERE is_active = TRUE';
  const params: any[] = [];
  if (floorId !== null) {
    query += ' AND floor_id = ?';
    params.push(floorId);
  }
  query += ' ORDER BY floor_id ASC, id ASC';

  const [students]: any = await pool.query(query, params);
  if (students.length === 0) {
    return { success: true, message: 'No active students found for analysis', total_evaluated: 0, total_assigned: 0 };
  }

  let totalEvaluated = 0;
  let totalAssigned = 0;
  const analysisSummary: any[] = [];

  for (let i = 0; i < students.length; i += batchSize) {
    const batch = students.slice(i, i + batchSize);
    const batchStudentIds = batch.map((s: any) => s.id);
    const statsMap = await getStudent20DayStats(batchStudentIds);

    const promptPayload = batch.map((s: any) => {
      const st = statsMap[s.id] || {};
      const attendancePercent = st.totalSessions > 0 ? Math.round((st.attended / st.totalSessions) * 100) : 0;
      const latePercent = st.attended > 0 ? Math.round((st.late / st.attended) * 100) : 0;
      return {
        student_id: s.id,
        name: s.name,
        room: s.room_number,
        floor: s.floor_id,
        attendance_rate_pct: attendancePercent,
        late_count: st.late,
        attended_count: st.attended,
        absent_count: st.absent,
        total_sessions_20d: st.totalSessions,
        recent_sessions_summary: st.recentDays?.join(', ')
      };
    });

    const aiPrompt = `
You are an AI Hostel Discipline & Attendance Officer.
Analyze the following student 20-day attendance statistics and assign EXACTLY ONE system tag per student from:
1. "Regular": Consistent attendance (>=75%), rarely absent or late.
2. "Irregular": Inconsistent attendance (<75% attendance rate or frequent unexcused absences).
3. "Late": Frequent late arrival (comes late in >=3 sessions or >=25% of attended sessions).

Input data:
${JSON.stringify(promptPayload, null, 2)}

Respond with a JSON array where each object has:
- "student_id": number
- "tag": string ("Regular" | "Irregular" | "Late")
- "reason": concise 1-sentence reasoning.
`;

    let aiResults: any[] = [];
    try {
      const response = await callGemini(aiPrompt);
      if (Array.isArray(response)) {
        aiResults = response;
      } else if (response && Array.isArray(response.results)) {
        aiResults = response.results;
      }
    } catch (apiErr: any) {
      console.error(`[Gemini AI] Batch analysis failed: ${apiErr.message}. Fallback to rule engine.`);
      // Rule-based fallback
      aiResults = promptPayload.map((p: any) => {
        if (p.late_count >= 3 || (p.attended_count > 0 && (p.late_count / p.attended_count) >= 0.25)) {
          return { student_id: p.student_id, tag: 'Late', reason: `Late in ${p.late_count} sessions.` };
        } else if (p.attendance_rate_pct >= 75) {
          return { student_id: p.student_id, tag: 'Regular', reason: `Consistent ${p.attendance_rate_pct}% attendance.` };
        } else {
          return { student_id: p.student_id, tag: 'Irregular', reason: `Low attendance rate of ${p.attendance_rate_pct}%.` };
        }
      });
    }

    for (const res of aiResults) {
      const studentId = parseInt(res.student_id, 10);
      const tagName = res.tag;
      const targetTagId = tagMap[tagName];

      if (studentId && targetTagId) {
        await pool.query(`
          DELETE FROM student_tag_assignments 
          WHERE student_id = ? AND tag_id IN (?)
        `, [studentId, systemTagIds]);

        await pool.query(`
          INSERT INTO student_tag_assignments (student_id, tag_id, assigned_by)
          VALUES (?, ?, 'GEMINI_AI')
          ON DUPLICATE KEY UPDATE assigned_by = 'GEMINI_AI', assigned_at = CURRENT_TIMESTAMP
        `, [studentId, targetTagId]);

        await pool.query(`
          INSERT INTO ai_tag_analysis_logs (student_id, assigned_tag, reason, analyzed_days)
          VALUES (?, ?, ?, 20)
        `, [studentId, tagName, res.reason || `Assigned ${tagName} based on 20-day attendance pattern.`]);

        totalAssigned++;
        analysisSummary.push({
          student_id: studentId,
          tag: tagName,
          reason: res.reason
        });
      }
    }

    totalEvaluated += batch.length;
    if (i + batchSize < students.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[Gemini AI] Tag analysis completed! Evaluated: ${totalEvaluated}, Tags Assigned: ${totalAssigned}`);
  return {
    success: true,
    message: `Gemini AI 20-day attendance analysis completed successfully. Evaluated ${totalEvaluated} students.`,
    total_evaluated: totalEvaluated,
    total_assigned: totalAssigned,
    sample_results: analysisSummary.slice(0, 10)
  };
}

export default {
  runAiTagAnalysis,
  ensureSystemTags,
  callGemini
};
