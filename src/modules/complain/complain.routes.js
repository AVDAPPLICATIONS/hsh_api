 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }import { Router, } from 'express';
import path from 'path';
import fs from 'fs';
import pool from '../../config/db';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { uploadComplainImages, COMPLAIN_UPLOAD_DIR } from '../../middleware/upload';

const router = Router();

// GET /api/complain/categories
router.get('/categories', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT compType FROM complains WHERE compType IS NOT NULL');
    const dbCategories = rows.map((r) => r.compType).filter(Boolean);
    const standardCategories = ['Electrical', 'Plumbing', 'Furniture', 'Cleaning', 'Internet', 'Carpentry', 'Other'];
    const allCategories = Array.from(new Set([...standardCategories, ...dbCategories])).sort();

    return res.json({ success: true, data: { categories: allCategories } });
  } catch (err) {
    console.error('Error fetching categories:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/complain (Student registers complaint)
router.post('/', requireAuth, uploadComplainImages.array('images', 5), async (req, res) => {
  try {
    const studentId = _optionalChain([req, 'access', _ => _.student, 'optionalAccess', _2 => _2.id]) || _optionalChain([req, 'access', _3 => _3.user, 'optionalAccess', _4 => _4.student_id]);
    if (!studentId) {
      return res.status(403).json({ success: false, message: 'Only students can file complaints' });
    }

    const { room, compDesc, compType } = req.body;
    if (!compDesc || !compType) {
      return res.status(400).json({ success: false, message: 'Complaint description and category (compType) are required' });
    }

    // 1. Check if student is locked out of this category (due to ignoring 24h feedback on a previous complaint)
    const [locks] = await pool.query(
      'SELECT id, locked_reason FROM student_category_locks WHERE student_id = ? AND category = ? AND is_locked = TRUE',
      [studentId, compType]
    );

    if (locks.length > 0) {
      return res.status(403).json({
        success: false,
        code: 'CATEGORY_LOCKED',
        message: `You are currently locked from filing complaints in "${compType}". Reason: ${locks[0].locked_reason}. Contact hostel administration to unlock.`
      });
    }

    // 2. Fetch student profile for default room if not specified
    const [students] = await pool.query('SELECT room_number FROM students WHERE id = ?', [studentId]);
    const finalRoom = room || _optionalChain([students, 'access', _5 => _5[0], 'optionalAccess', _6 => _6.room_number]) || '';

    // 3. Create active complaint record
    const [insertResult] = await pool.query(
      `INSERT INTO complains (student_id, room, compDesc, compType, status, images, submitTime)
       VALUES (?, ?, ?, ?, 'pending', 0, NOW())`,
      [studentId, finalRoom, compDesc, compType]
    );
    const complainId = insertResult.insertId;

    // 4. Rename uploaded files to complain_{id}_{index}.ext
    const files = req.files ;
    let fileCount = 0;
    if (files && files.length > 0) {
      fileCount = files.length;
      files.forEach((file, index) => {
        const ext = path.extname(file.originalname || file.filename);
        const newFileName = `complain_${complainId}_${index}${ext}`;
        const newFilePath = path.join(COMPLAIN_UPLOAD_DIR, newFileName);
        if (fs.existsSync(file.path)) {
          fs.renameSync(file.path, newFilePath);
        }
      });

      await pool.query('UPDATE complains SET images = ? WHERE id = ?', [fileCount, complainId]);
    }

    const [complainRows] = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    return res.status(201).json({ success: true, data: { complain: complainRows[0] } });
  } catch (err) {
    console.error('Error creating complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/complain (Scoped list of complaints)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, room, category, aadhar, student_code, bank_code, student_id } = req.query;
    const isPlatformAdmin = _optionalChain([req, 'access', _7 => _7.roles, 'optionalAccess', _8 => _8.includes, 'call', _9 => _9('platform-admin')]);
    const isSolver = _optionalChain([req, 'access', _10 => _10.roles, 'optionalAccess', _11 => _11.includes, 'call', _12 => _12('complain-solver')]);
    const isLeader = _optionalChain([req, 'access', _13 => _13.roles, 'optionalAccess', _14 => _14.includes, 'call', _15 => _15('leader')]) || _optionalChain([req, 'access', _16 => _16.roles, 'optionalAccess', _17 => _17.includes, 'call', _18 => _18('wing-leader')]);
    const isOnlyStudent = !isPlatformAdmin && !isSolver && !isLeader;

    let query = `
      SELECT c.*, s.name AS student_name, s.student_code, s.phone_number, s.room_number,
             su.name AS solver_name
      FROM complains c
      LEFT JOIN students s ON c.student_id = s.id
      LEFT JOIN staff_users su ON c.assigned_solver_id = su.id
      WHERE 1=1
    `;
    const params = [];

    // Filter by student identity if regular student
    if (isOnlyStudent) {
      query += ' AND c.student_id = ?';
      params.push(_optionalChain([req, 'access', _19 => _19.user, 'optionalAccess', _20 => _20.student_id]) || _optionalChain([req, 'access', _21 => _21.student, 'optionalAccess', _22 => _22.id]));
    } else if (isLeader && !isPlatformAdmin) {
      // Leader/Wing-Leader: filter to assigned rooms or floors
      const leaderScope = _optionalChain([req, 'access', _23 => _23.user, 'optionalAccess', _24 => _24.scope]);
      if (_optionalChain([leaderScope, 'optionalAccess', _25 => _25.assigned_rooms]) && leaderScope.assigned_rooms.length > 0) {
        query += ' AND c.room IN (?)';
        params.push(leaderScope.assigned_rooms);
      }
    } else {
      const studentFilter = aadhar || student_code || bank_code;
      if (studentFilter) {
        query += ' AND s.student_code = ?';
        params.push(studentFilter);
      } else if (student_id) {
        query += ' AND c.student_id = ?';
        params.push(parseInt(student_id , 10));
      }
    }

    if (status) {
      let dbStatus = status;
      if (status === 'reviewed') dbStatus = 'in_progress';
      else if (status === 'resolved') dbStatus = 'solved';
      query += ' AND c.status = ?';
      params.push(dbStatus);
    }
    if (room) {
      query += ' AND c.room = ?';
      params.push(room);
    }
    if (category) {
      query += ' AND c.compType = ?';
      params.push(category);
    }

    query += ' ORDER BY c.submitTime DESC';
    const [rows] = await pool.query(query, params);

    const formatted = rows.map((r) => ({
      ...r,
      aadhar: r.student_code,
      studentAadhar: r.student_code,
      fullName: r.student_name,
      studentName: r.student_name,
      response: r.solver_response,
      review: r.student_feedback,
      resolveTime: r.resolveTime || r.solvedTime,
      phone: r.phone_number
    }));

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error listing complaints:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/complain/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const complainId = parseInt(req.params.id , 10);
    const [rows] = await pool.query(`
      SELECT c.*, s.name AS student_name, s.student_code, s.phone_number, s.room_number,
             su.name AS solver_name
      FROM complains c
      LEFT JOIN students s ON c.student_id = s.id
      LEFT JOIN staff_users su ON c.assigned_solver_id = su.id
      WHERE c.id = ?
    `, [complainId]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }

    const complaint = rows[0];

    // If standard student, verify ownership
    if (!_optionalChain([req, 'access', _26 => _26.roles, 'optionalAccess', _27 => _27.some, 'call', _28 => _28(r => ['platform-admin', 'complain-solver', 'leader', 'wing-leader'].includes(r))])) {
      if (complaint.student_id !== (_optionalChain([req, 'access', _29 => _29.user, 'optionalAccess', _30 => _30.student_id]) || _optionalChain([req, 'access', _31 => _31.student, 'optionalAccess', _32 => _32.id]))) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
    }

    const formatted = {
      ...complaint,
      aadhar: complaint.student_code,
      studentAadhar: complaint.student_code,
      fullName: complaint.student_name,
      studentName: complaint.student_name,
      response: complaint.solver_response,
      review: complaint.student_feedback,
      resolveTime: complaint.resolveTime || complaint.solvedTime,
      phone: complaint.phone_number
    };

    return res.json({ success: true, data: { ...formatted, complain: formatted } });
  } catch (err) {
    console.error('Error getting complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH & PUT /api/complain/:id (General update for status, response, review)
const handleUpdateComplaint = async (req, res) => {
  try {
    const complainId = parseInt(req.params.id , 10);
    const { status, response, review } = req.body;

    const [existing] = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }

    const updateFields = [];
    const params = [];

    if (status !== undefined) {
      let dbStatus = status;
      if (status === 'reviewed') dbStatus = 'in_progress';
      if (status === 'resolved') dbStatus = 'solved';
      updateFields.push('status = ?');
      params.push(dbStatus);

      if (dbStatus === 'solved' || status === 'resolved') {
        updateFields.push('solvedTime = NOW()');
        updateFields.push('resolveTime = NOW()');
      }
    }

    if (response !== undefined) {
      updateFields.push('solver_response = ?');
      params.push(response);
    }

    if (review !== undefined) {
      updateFields.push('student_feedback = ?');
      params.push(review);
    }

    if (updateFields.length > 0) {
      params.push(complainId);
      await pool.query(`UPDATE complains SET ${updateFields.join(', ')} WHERE id = ?`, params);
    }

    const [rows] = await pool.query(`
      SELECT c.*, s.name AS student_name, s.student_code, s.phone_number, s.room_number,
             su.name AS solver_name
      FROM complains c
      LEFT JOIN students s ON c.student_id = s.id
      LEFT JOIN staff_users su ON c.assigned_solver_id = su.id
      WHERE c.id = ?
    `, [complainId]);

    const updated = rows[0];
    const formatted = {
      ...updated,
      aadhar: updated.student_code,
      studentAadhar: updated.student_code,
      fullName: updated.student_name,
      studentName: updated.student_name,
      response: updated.solver_response,
      review: updated.student_feedback,
      resolveTime: updated.resolveTime || updated.solvedTime,
      phone: updated.phone_number
    };

    return res.json({ success: true, data: { ...formatted, complain: formatted } });
  } catch (err) {
    console.error('Error updating complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

router.patch('/:id', requireAuth, handleUpdateComplaint);
router.put('/:id', requireAuth, handleUpdateComplaint);


// PATCH /api/complain/:id/solve (Complain-Solver or Admin marks as solved)
router.patch('/:id/solve', requireAuth, requireRole('complain-solver', 'platform-admin'), async (req, res) => {
  try {
    const complainId = parseInt(req.params.id , 10);
    const { response } = req.body;
    const solverId = _optionalChain([req, 'access', _33 => _33.user, 'optionalAccess', _34 => _34.staff_id]) || null;

    const [existing] = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }

    // Set status to solved, record solver_response, and trigger 24h countdown by setting solvedTime = NOW()
    await pool.query(
      `UPDATE complains 
       SET status = 'solved', 
           solver_response = ?, 
           assigned_solver_id = ?, 
           solvedTime = NOW() 
       WHERE id = ?`,
      [response || 'Issue resolved by staff', solverId, complainId]
    );

    const [updated] = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    return res.json({
      success: true,
      message: 'Complaint marked as solved. 24-hour verification window has begun for the student.',
      data: updated[0]
    });
  } catch (err) {
    console.error('Error solving complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/complain/:id/feedback (Student feedback on solved complaint)
router.post('/:id/feedback', requireAuth, async (req, res) => {
  try {
    const complainId = parseInt(req.params.id , 10);
    const studentId = _optionalChain([req, 'access', _35 => _35.user, 'optionalAccess', _36 => _36.student_id]) || _optionalChain([req, 'access', _37 => _37.student, 'optionalAccess', _38 => _38.id]);
    const { is_resolved, feedback, rating } = req.body;

    if (is_resolved === undefined) {
      return res.status(400).json({ success: false, message: 'is_resolved (boolean) is required' });
    }

    const [rows] = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }

    const complaint = rows[0];
    if (complaint.student_id !== studentId && !_optionalChain([req, 'access', _39 => _39.roles, 'optionalAccess', _40 => _40.includes, 'call', _41 => _41('platform-admin')])) {
      return res.status(403).json({ success: false, message: 'You can only provide feedback for your own complaints' });
    }

    if (complaint.status !== 'solved') {
      return res.status(400).json({
        success: false,
        message: `Complaint is currently '${complaint.status}'. Feedback can only be submitted for 'solved' complaints.`
      });
    }

    if (is_resolved) {
      // 1. Confirmed fixed! Archive and remove from active complains table as requested
      await pool.query(`
        INSERT INTO complains_archive 
          (id, student_id, room, compType, compDesc, images, status, assigned_solver_id, solver_response, student_feedback, student_rating, submitTime, solvedTime, archivedTime)
        VALUES 
          (?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?, ?, ?, ?, NOW())
      `, [
        complaint.id, complaint.student_id, complaint.room, complaint.compType, complaint.compDesc,
        complaint.images, complaint.assigned_solver_id, complaint.solver_response,
        feedback || null, rating || null, complaint.submitTime, complaint.solvedTime
      ]);

      // Remove from active database table
      await pool.query('DELETE FROM complains WHERE id = ?', [complainId]);

      // Also ensure any category lock for this category is unlocked
      await pool.query('DELETE FROM student_category_locks WHERE student_id = ? AND category = ?', [studentId, complaint.compType]);

      return res.json({
        success: true,
        message: 'Resolution confirmed. Complaint has been archived and removed from active list.'
      });
    } else {
      // 2. Student reports issue is NOT fixed -> Reopen ticket
      await pool.query(`
        UPDATE complains 
        SET status = 'in_progress', 
            student_feedback = ?, 
            solvedTime = NULL 
        WHERE id = ?
      `, [feedback || 'Student reported issue was not resolved', complainId]);

      return res.json({
        success: true,
        message: 'Complaint reopened and set back to in_progress for solver re-inspection.'
      });
    }
  } catch (err) {
    console.error('Error submitting feedback:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/complain/unlock-category (Platform-admin lifts a 24h category lock)
router.post('/unlock-category', requireAuth, requireRole('platform-admin'), async (req, res) => {
  try {
    const { student_id, category } = req.body;
    if (!student_id || !category) {
      return res.status(400).json({ success: false, message: 'student_id and category are required' });
    }

    await pool.query(
      'UPDATE student_category_locks SET is_locked = FALSE, unlocked_at = NOW(), unlocked_by = ? WHERE student_id = ? AND category = ?',
      [_optionalChain([req, 'access', _42 => _42.user, 'optionalAccess', _43 => _43.staff_id]) || 1, student_id, category]
    );

    return res.json({ success: true, message: `Category "${category}" successfully unlocked for student ${student_id}.` });
  } catch (err) {
    console.error('Error unlocking category:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/complain/:id (Platform-Admin only)
router.delete('/:id', requireAuth, requireRole('platform-admin'), async (req, res) => {
  try {
    const complainId = parseInt(req.params.id , 10);
    const [rows] = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }

    // Clean up physical images
    try {
      const files = fs.readdirSync(COMPLAIN_UPLOAD_DIR);
      const prefix = `complain_${complainId}_`;
      files.forEach((file) => {
        if (file.startsWith(prefix)) {
          const filePath = path.join(COMPLAIN_UPLOAD_DIR, file);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      });
    } catch (e) {
      console.warn('Could not clean up some image files:', e.message);
    }

    await pool.query('DELETE FROM complains WHERE id = ?', [complainId]);
    return res.json({ success: true, message: 'Complaint and associated images deleted' });
  } catch (err) {
    console.error('Error deleting complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
