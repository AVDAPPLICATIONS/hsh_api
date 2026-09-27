 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }import { Router, } from 'express';
import pool from '../../config/db';
import { verifyAdmin, verifyAdminOrFloorLeader } from '../../middleware/auth';
import { runAiTagAnalysis } from '../../services/geminiTagger';

const router = Router();
router.use(verifyAdminOrFloorLeader);

// GET /api/tags
router.get('/', async (_req, res) => {
  try {
    const [tags] = await pool.query(`
      SELECT t.*, COUNT(sta.student_id) AS student_count
      FROM student_tags t
      LEFT JOIN student_tag_assignments sta ON t.id = sta.tag_id
      GROUP BY t.id
      ORDER BY t.is_system DESC, t.name ASC
    `);
    return res.json({ success: true, data: tags });
  } catch (err) {
    console.error('Error fetching tags:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// POST /api/tags
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const { name, color, description } = req.body;
    const tagName = (name || '').trim();
    if (!tagName) {
      return res.status(400).json({ success: false, message: 'Tag name is required' });
    }

    const tagColor = color || '#6366f1';
    const tagDesc = description || null;

    const [existing] = await pool.query('SELECT id FROM student_tags WHERE LOWER(name) = LOWER(?)', [tagName]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'A tag with this name already exists' });
    }

    const [result] = await pool.query(
      'INSERT INTO student_tags (name, color, is_system, description) VALUES (?, ?, FALSE, ?)',
      [tagName, tagColor, tagDesc]
    );

    return res.status(201).json({
      success: true,
      data: {
        id: result.insertId,
        name: tagName,
        color: tagColor,
        is_system: 0,
        description: tagDesc
      },
      message: 'Tag created successfully'
    });
  } catch (err) {
    console.error('Error creating tag:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// DELETE /api/tags/:id
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const tagId = req.params.id;
    const [tag] = await pool.query('SELECT * FROM student_tags WHERE id = ?', [tagId]);
    if (tag.length === 0) {
      return res.status(404).json({ success: false, message: 'Tag not found' });
    }

    if (tag[0].is_system) {
      return res.status(403).json({ success: false, message: 'System default tags cannot be deleted' });
    }

    await pool.query('DELETE FROM student_tag_assignments WHERE tag_id = ?', [tagId]);
    await pool.query('DELETE FROM student_tags WHERE id = ?', [tagId]);

    return res.json({ success: true, message: 'Tag deleted successfully' });
  } catch (err) {
    console.error('Error deleting tag:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// GET /api/tags/student/:student_id
router.get('/student/:student_id', async (req, res) => {
  try {
    const studentId = req.params.student_id;
    const [students] = await pool.query('SELECT id, student_code, name FROM students WHERE id = ?', [studentId]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const student = students[0];
    const cleanCode = (student.student_code || '').replace(/^0+/, '');

    const [assignedTags] = await pool.query(`
      SELECT t.id, t.name, t.color, t.is_system, t.description, sta.assigned_at
      FROM student_tags t
      JOIN student_tag_assignments sta ON t.id = sta.tag_id
      WHERE sta.student_id = ?
      ORDER BY sta.assigned_at ASC
    `, [studentId]);

    const [recentAttendance] = await pool.query(`
      SELECT ar.is_late, ses.session_date
      FROM attendance_records ar
      JOIN attendance_sessions ses ON ar.session_id = ses.id
      WHERE ar.student_id = ? OR TRIM(LEADING '0' FROM ar.bank_code) = ?
      ORDER BY ses.session_date DESC
      LIMIT 10
    `, [studentId, cleanCode]);

    const [totalSessionsRow] = await pool.query(`
      SELECT COUNT(DISTINCT session_date) as total_days
      FROM attendance_sessions
      WHERE session_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
    `);
    const totalDays = _optionalChain([totalSessionsRow, 'access', _ => _[0], 'optionalAccess', _2 => _2.total_days]) || 1;

    let systemTag = {
      name: 'Regular',
      color: '#10b981',
      description: 'Attends attendance regularly',
      type: 'SYSTEM'
    };

    let consecutiveLate = 0;
    for (const rec of recentAttendance) {
      if (rec.is_late) consecutiveLate++;
      else break;
    }

    if (consecutiveLate >= 3) {
      systemTag = {
        name: 'Late',
        color: '#ef4444',
        description: 'Comes late to attendance',
        type: 'SYSTEM'
      };
    } else {
      const attendedCount = recentAttendance.length;
      const attendanceRate = totalDays > 0 ? (attendedCount / totalDays) * 100 : 100;

      if (attendanceRate < 40) {
        systemTag = {
          name: 'Irregular',
          color: '#f59e0b',
          description: 'Inconsistent attendance / frequent absences',
          type: 'SYSTEM'
        };
      } else if (attendanceRate < 75) {
        systemTag = {
          name: 'Irregular',
          color: '#f59e0b',
          description: 'Moderate attendance with absences',
          type: 'SYSTEM'
        };
      } else {
        systemTag = {
          name: 'Regular',
          color: '#10b981',
          description: 'Consistent daily attendance (>=75%)',
          type: 'SYSTEM'
        };
      }
    }

    let aiLog = null;
    try {
      const [logs] = await pool.query(
        'SELECT assigned_tag, reason, analyzed_days, analyzed_at FROM ai_tag_analysis_logs WHERE student_id = ? ORDER BY id DESC LIMIT 1',
        [studentId]
      );
      if (logs.length > 0) aiLog = logs[0];
    } catch (e) {}

    return res.json({
      success: true,
      data: {
        student_id: student.id,
        student_code: student.student_code,
        name: student.name,
        system_tag: systemTag,
        assigned_tags: assignedTags,
        manual_tag_count: assignedTags.length,
        max_allowed: 3,
        ai_analysis: aiLog
      }
    });
  } catch (err) {
    console.error('Error fetching student tags:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// POST /api/tags/ai-analyze
router.post('/ai-analyze', async (req, res) => {
  try {
    const { floor_id, batch_size } = req.body;
    const targetFloor = req.leader ? (req.leader.floor_id || null) : (floor_id || null);

    const result = await runAiTagAnalysis({
      floorId: targetFloor,
      batchSize: batch_size ? parseInt(batch_size, 10) : 25
    });

    return res.json({
      success: true,
      message: result.message,
      data: result
    });
  } catch (err) {
    console.error('Error triggering AI tag analysis:', err);
    return res.status(500).json({ success: false, message: 'Gemini AI Analysis error: ' + err.message });
  }
});

// GET /api/tags/ai-logs/:student_id
router.get('/ai-logs/:student_id', async (req, res) => {
  try {
    const studentId = req.params.student_id;
    const [logs] = await pool.query(`
      SELECT id, assigned_tag, reason, analyzed_days, analyzed_at
      FROM ai_tag_analysis_logs
      WHERE student_id = ?
      ORDER BY id DESC
      LIMIT 10
    `, [studentId]);

    return res.json({ success: true, data: logs });
  } catch (err) {
    console.error('Error fetching AI logs:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// POST /api/tags/student/:student_id
router.post('/student/:student_id', async (req, res) => {
  try {
    const studentId = req.params.student_id;
    const { tag_id } = req.body;

    if (!tag_id) {
      return res.status(400).json({ success: false, message: 'tag_id is required' });
    }

    const [tagRows] = await pool.query('SELECT * FROM student_tags WHERE id = ?', [tag_id]);
    if (tagRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tag not found' });
    }

    const [[countRow]] = await pool.query(
      'SELECT COUNT(*) as tagCount FROM student_tag_assignments WHERE student_id = ?',
      [studentId]
    );

    if (_optionalChain([countRow, 'optionalAccess', _3 => _3.tagCount]) >= 3) {
      return res.status(400).json({
        success: false,
        message: 'Limit reached: A maximum of 3 manual tags can be assigned per student. Please remove a tag before adding another.'
      });
    }

    await pool.query(`
      INSERT INTO student_tag_assignments (student_id, tag_id, assigned_by)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE assigned_at = CURRENT_TIMESTAMP
    `, [studentId, tag_id, req.admin ? 'ADMIN' : (req.leader ? 'LEADER' : 'ADMIN')]);

    return res.json({
      success: true,
      message: `Tag "${tagRows[0].name}" assigned to student successfully`
    });
  } catch (err) {
    console.error('Error assigning tag:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

// DELETE /api/tags/student/:student_id/:tag_id
router.delete('/student/:student_id/:tag_id', async (req, res) => {
  try {
    const { student_id, tag_id } = req.params;
    await pool.query(
      'DELETE FROM student_tag_assignments WHERE student_id = ? AND tag_id = ?',
      [student_id, tag_id]
    );
    return res.json({ success: true, message: 'Tag removed from student successfully' });
  } catch (err) {
    console.error('Error removing tag:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

export default router;
