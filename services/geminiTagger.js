const https = require('https');
const pool = require('../config/db');

const GEMINI_API_KEYS = [
  'AQ.Ab8RN6LRazDitAQspknrVSVlhWQS3NFmuIk6VH3cXq6tLqivyA',
  'AQ.Ab8RN6LnpAeetY0ymbv6UME4my6yAXmxeOccp7fYeKi2Qq8vCw',
  'AQ.Ab8RN6J05SaB7nUWSs9JDifWAC0LVgXU1l72t3Sx0TaY-uG6yQ'
];

/**
 * Call Google Gemini REST API with key rotation and fallback models
 */
async function callGemini(promptText) {
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

  // Try each key and model combination
  for (const currentKey of GEMINI_API_KEYS) {
    for (const model of models) {
      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          const response = await new Promise((resolve, reject) => {
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
            // Quota reached or model busy on this key -> switch to next key/model
            console.warn(`[Gemini AI] Key/Model (${model}) returned status ${response.statusCode}. Switching to next key/model...`);
            break;
          }
        } catch (err) {
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
async function ensureSystemTags() {
  // 1. Rename old "Late 3+ Days" to "Late" if exists
  await pool.query(`
    UPDATE student_tags 
    SET name = 'Late', description = 'Comes late to attendance' 
    WHERE name = 'Late 3+ Days'
  `);

  // 2. Ensure standard 3 system tags exist
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

  // 3. Ensure AI tag analysis logs table exists
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

  // Fetch mapping { "Regular": id, "Irregular": id, "Late": id }
  const [tagRows] = await pool.query('SELECT id, name FROM student_tags WHERE name IN ("Regular", "Irregular", "Late")');
  const tagMap = {};
  for (const r of tagRows) {
    tagMap[r.name] = r.id;
  }
  return tagMap;
}

/**
 * Gather last 20 days attendance data for students
 */
async function getStudent20DayStats(studentIds) {
  if (!studentIds || studentIds.length === 0) return {};

  const [sessions] = await pool.query(`
    SELECT id, session_date, session_type
    FROM attendance_sessions
    WHERE session_date >= DATE_SUB(CURDATE(), INTERVAL 20 DAY)
    ORDER BY session_date DESC, id DESC
  `);

  const sessionIds = sessions.map(s => s.id);
  if (sessionIds.length === 0) {
    const emptyStats = {};
    for (const sid of studentIds) {
      emptyStats[sid] = { totalSessions: 0, attended: 0, late: 0, onTime: 0, absent: 0, recentDays: [] };
    }
    return emptyStats;
  }

  const [records] = await pool.query(`
    SELECT ar.student_id, ar.bank_code, ar.session_id, ar.is_late, ar.marked_at, ses.session_date, ses.session_type
    FROM attendance_records ar
    JOIN attendance_sessions ses ON ar.session_id = ses.id
    WHERE ses.id IN (?)
  `, [sessionIds]);

  const statsMap = {};
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
    const sRecords = records.filter(r => r.student_id === sid);

    statsMap[sid].attended = sRecords.length;
    statsMap[sid].late = sRecords.filter(r => r.is_late).length;
    statsMap[sid].onTime = sRecords.filter(r => !r.is_late).length;
    statsMap[sid].absent = Math.max(0, sessions.length - sRecords.length);

    // Timeline summary for last 5 sessions
    for (const ses of sessions.slice(0, 5)) {
      const rec = sRecords.find(r => r.session_id === ses.id);
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
async function runAiTagAnalysis({ floorId = null, batchSize = 25 } = {}) {
  console.log(`[Gemini AI] Starting 20-day attendance tag analysis... (Floor: ${floorId || 'ALL'})`);
  
  const tagMap = await ensureSystemTags();
  const systemTagIds = Object.values(tagMap);

  let studentQuery = 'SELECT id, name, student_code, floor_id, room_number FROM students WHERE is_active = TRUE';
  let params = [];
  if (floorId && floorId !== 'All') {
    studentQuery += ' AND floor_id = ?';
    params.push(floorId);
  }
  studentQuery += ' ORDER BY id ASC';

  const [students] = await pool.query(studentQuery, params);
  if (students.length === 0) {
    return { success: true, message: 'No active students found to analyze', total: 0, updated: 0 };
  }

  console.log(`[Gemini AI] Found ${students.length} students to evaluate.`);
  let totalEvaluated = 0;
  let totalAssigned = 0;
  const analysisSummary = [];

  // Process in batches
  for (let i = 0; i < students.length; i += batchSize) {
    const batch = students.slice(i, i + batchSize);
    const studentIds = batch.map(s => s.id);
    const statsMap = await getStudent20DayStats(studentIds);

    // Build compact prompt for Gemini
    const studentsPromptData = batch.map(s => {
      const stat = statsMap[s.id] || {};
      const rate = stat.totalSessions > 0 ? ((stat.attended / stat.totalSessions) * 100).toFixed(0) : '100';
      return {
        id: s.id,
        name: s.name,
        sessions: stat.totalSessions,
        att: stat.attended,
        late: stat.late,
        abs: stat.absent,
        rate: `${rate}%`,
        recent: stat.recentDays.join(',')
      };
    });

    const promptText = `
You are the AI Attendance Auditor for a student hostel.
Classify each student based on their last 20-day attendance summary into ONE tag:
- "Late": Student frequently comes late to attendance (high late count, e.g. late in majority of attended sessions or recent consecutive sessions).
- "Irregular": Inconsistent attendance, frequent absences, or low attendance rate (<75%).
- "Regular": Consistently attends on time (>=75% attendance rate with minimal late arrivals).

Data:
${JSON.stringify(studentsPromptData)}

Return JSON array:
[
  {
    "id": 123,
    "tag": "Late", // "Late" | "Irregular" | "Regular"
    "reason": "1-sentence reason"
  }
]
`;

    let aiResults = [];
    try {
      aiResults = await callGemini(promptText);
    } catch (apiErr) {
      console.error(`[Gemini AI] API call failed for batch ${i}-${i + batch.length}:`, apiErr.message);
      // Fallback rule engine if Gemini experiences temporary failure
      aiResults = batch.map(s => {
        const stat = statsMap[s.id] || {};
        const rate = stat.totalSessions > 0 ? (stat.attended / stat.totalSessions) * 100 : 100;
        let tag = 'Regular';
        let reason = 'Consistent on-time attendance';

        if (stat.late >= 3 && stat.late >= stat.onTime) {
          tag = 'Late';
          reason = `Late ${stat.late} times in past 20 days.`;
        } else if (rate < 75) {
          tag = 'Irregular';
          reason = `Low attendance rate (${rate.toFixed(0)}%) with ${stat.absent} absences.`;
        } else {
          tag = 'Regular';
          reason = `Consistent on-time attendance (${rate.toFixed(0)}%).`;
        }
        return { id: s.id, tag, reason };
      });
    }

    // Apply tags to database
    for (const res of aiResults) {
      const studentId = res.id || res.student_id;
      const tagName = ['Late', 'Irregular', 'Regular'].includes(res.tag) ? res.tag : 'Regular';
      const targetTagId = tagMap[tagName];

      if (targetTagId && studentId) {
        // Remove existing system tags for this student to prevent duplicate conflicting system tags
        await pool.query(`
          DELETE FROM student_tag_assignments 
          WHERE student_id = ? AND tag_id IN (?)
        `, [studentId, systemTagIds]);

        // Insert new assigned system tag
        await pool.query(`
          INSERT INTO student_tag_assignments (student_id, tag_id, assigned_by)
          VALUES (?, ?, 'GEMINI_AI')
          ON DUPLICATE KEY UPDATE assigned_by = 'GEMINI_AI', assigned_at = CURRENT_TIMESTAMP
        `, [studentId, targetTagId]);

        // Record log
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
    console.log(`[Gemini AI] Processed ${totalEvaluated}/${students.length} students...`);
    
    // Short pause between batches to avoid throttling
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

module.exports = {
  runAiTagAnalysis,
  ensureSystemTags,
  callGemini
};
