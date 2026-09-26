import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import pool from '../../config/db';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { uploadComplainImages, COMPLAIN_UPLOAD_DIR } from '../../middleware/upload';

const router = Router();

// GET /api/complain/categories
router.get('/categories', async (_req: Request, res: Response) => {
  try {
    const [rows]: any = await pool.query('SELECT DISTINCT compType FROM complains WHERE compType IS NOT NULL');
    const dbCategories = rows.map((r: any) => r.compType).filter(Boolean);
    const standardCategories = ['Electrical', 'Plumbing', 'Furniture', 'Cleaning', 'Internet', 'Carpentry', 'Other'];
    const allCategories = Array.from(new Set([...standardCategories, ...dbCategories])).sort();

    return res.json({ success: true, data: { categories: allCategories } });
  } catch (err: any) {
    console.error('Error fetching categories:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/complain (Student registers complaint)
router.post('/', requireAuth, uploadComplainImages.array('images', 5), async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.student?.id || req.user?.student_id;
    if (!studentId) {
      return res.status(403).json({ success: false, message: 'Only students can file complaints' });
    }

    const { room, compDesc, compType } = req.body;
    if (!compDesc || !compType) {
      return res.status(400).json({ success: false, message: 'Complaint description and category (compType) are required' });
    }

    // 1. Check if student is locked out of this category (due to ignoring 24h feedback on a previous complaint)
    const [locks]: any = await pool.query(
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
    const [students]: any = await pool.query('SELECT room_number FROM students WHERE id = ?', [studentId]);
    const finalRoom = room || students[0]?.room_number || '';

    // 3. Create active complaint record
    const [insertResult]: any = await pool.query(
      `INSERT INTO complains (student_id, room, compDesc, compType, status, images, submitTime)
       VALUES (?, ?, ?, ?, 'pending', 0, NOW())`,
      [studentId, finalRoom, compDesc, compType]
    );
    const complainId = insertResult.insertId;

    // 4. Rename uploaded files to complain_{id}_{index}.ext
    const files = req.files as Express.Multer.File[];
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

    const [complainRows]: any = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    return res.status(201).json({ success: true, data: { complain: complainRows[0] } });
  } catch (err: any) {
    console.error('Error creating complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/complain (Scoped list of complaints)
router.get('/', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const { status, room, category } = req.query;
    const isPlatformAdmin = req.roles?.includes('platform-admin');
    const isSolver = req.roles?.includes('complain-solver');
    const isLeader = req.roles?.includes('leader') || req.roles?.includes('wing-leader');
    const isOnlyStudent = !isPlatformAdmin && !isSolver && !isLeader;

    let query = `
      SELECT c.*, s.name AS student_name, s.student_code, s.phone_number, s.room_number,
             su.name AS solver_name
      FROM complains c
      LEFT JOIN students s ON c.student_id = s.id
      LEFT JOIN staff_users su ON c.assigned_solver_id = su.id
      WHERE 1=1
    `;
    const params: any[] = [];

    // Filter by student identity if regular student
    if (isOnlyStudent) {
      query += ' AND c.student_id = ?';
      params.push(req.user?.student_id || req.student?.id);
    } else if (isLeader && !isPlatformAdmin) {
      // Leader/Wing-Leader: filter to assigned rooms or floors
      const leaderScope = req.user?.scope;
      if (leaderScope?.assigned_rooms && leaderScope.assigned_rooms.length > 0) {
        query += ' AND c.room IN (?)';
        params.push(leaderScope.assigned_rooms);
      }
    }

    if (status) {
      query += ' AND c.status = ?';
      params.push(status);
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
    const [rows]: any = await pool.query(query, params);

    return res.json({ success: true, data: rows });
  } catch (err: any) {
    console.error('Error listing complaints:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/complain/:id
router.get('/:id', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const complainId = parseInt(req.params.id as string, 10);
    const [rows]: any = await pool.query(`
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
    if (!req.roles?.some(r => ['platform-admin', 'complain-solver', 'leader', 'wing-leader'].includes(r))) {
      if (complaint.student_id !== (req.user?.student_id || req.student?.id)) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
    }

    return res.json({ success: true, data: complaint });
  } catch (err: any) {
    console.error('Error getting complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/complain/:id/solve (Complain-Solver or Admin marks as solved)
router.patch('/:id/solve', requireAuth, requireRole('complain-solver', 'platform-admin'), async (req: Request, res: Response): Promise<any> => {
  try {
    const complainId = parseInt(req.params.id as string, 10);
    const { response } = req.body;
    const solverId = req.user?.staff_id || null;

    const [existing]: any = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
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

    const [updated]: any = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    return res.json({
      success: true,
      message: 'Complaint marked as solved. 24-hour verification window has begun for the student.',
      data: updated[0]
    });
  } catch (err: any) {
    console.error('Error solving complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/complain/:id/feedback (Student feedback on solved complaint)
router.post('/:id/feedback', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const complainId = parseInt(req.params.id as string, 10);
    const studentId = req.user?.student_id || req.student?.id;
    const { is_resolved, feedback, rating } = req.body;

    if (is_resolved === undefined) {
      return res.status(400).json({ success: false, message: 'is_resolved (boolean) is required' });
    }

    const [rows]: any = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }

    const complaint = rows[0];
    if (complaint.student_id !== studentId && !req.roles?.includes('platform-admin')) {
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
  } catch (err: any) {
    console.error('Error submitting feedback:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/complain/unlock-category (Platform-admin lifts a 24h category lock)
router.post('/unlock-category', requireAuth, requireRole('platform-admin'), async (req: Request, res: Response): Promise<any> => {
  try {
    const { student_id, category } = req.body;
    if (!student_id || !category) {
      return res.status(400).json({ success: false, message: 'student_id and category are required' });
    }

    await pool.query(
      'UPDATE student_category_locks SET is_locked = FALSE, unlocked_at = NOW(), unlocked_by = ? WHERE student_id = ? AND category = ?',
      [req.user?.staff_id || 1, student_id, category]
    );

    return res.json({ success: true, message: `Category "${category}" successfully unlocked for student ${student_id}.` });
  } catch (err: any) {
    console.error('Error unlocking category:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/complain/:id (Platform-Admin only)
router.delete('/:id', requireAuth, requireRole('platform-admin'), async (req: Request, res: Response): Promise<any> => {
  try {
    const complainId = parseInt(req.params.id as string, 10);
    const [rows]: any = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
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
    } catch (e: any) {
      console.warn('Could not clean up some image files:', e.message);
    }

    await pool.query('DELETE FROM complains WHERE id = ?', [complainId]);
    return res.json({ success: true, message: 'Complaint and associated images deleted' });
  } catch (err: any) {
    console.error('Error deleting complaint:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
