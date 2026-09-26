import { Router, Request, Response } from 'express';
import pool from '../../config/db';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';

const router = Router();

// POST /api/delegation/grant (Grant temporary role to a student)
router.post('/grant', requireAuth, requireRole('platform-admin', 'leader'), async (req: Request, res: Response): Promise<any> => {
  try {
    const { student_id, delegated_role, entitlements, valid_until } = req.body;

    if (!student_id || !delegated_role || !valid_until) {
      return res.status(400).json({ success: false, message: 'student_id, delegated_role, and valid_until are required' });
    }

    const allowedRoles = ['leader', 'wing-leader', 'complain-solver', 'laundry-man'];
    if (!allowedRoles.includes(delegated_role)) {
      return res.status(400).json({ success: false, message: `delegated_role must be one of: ${allowedRoles.join(', ')}` });
    }

    // Verify student exists
    const [students]: any = await pool.query('SELECT id, name FROM students WHERE id = ?', [student_id]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: `Student ID ${student_id} not found` });
    }

    const delegatorId = req.user?.id || 1;
    const [result]: any = await pool.query(
      `INSERT INTO role_delegations 
        (delegator_id, student_id, delegated_role, entitlements, valid_from, valid_until, is_active)
       VALUES (?, ?, ?, ?, NOW(), ?, TRUE)`,
      [
        delegatorId,
        student_id,
        delegated_role,
        entitlements ? JSON.stringify(entitlements) : null,
        valid_until
      ]
    );

    return res.status(201).json({
      success: true,
      message: `Role "${delegated_role}" successfully delegated to student ${students[0].name} until ${valid_until}`,
      delegation_id: result.insertId
    });
  } catch (err: any) {
    console.error('Error granting delegation:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/delegation/revoke/:id
router.post('/revoke/:id', requireAuth, requireRole('platform-admin', 'leader'), async (req: Request, res: Response): Promise<any> => {
  try {
    const delegationId = parseInt(req.params.id as string, 10);
    await pool.query('UPDATE role_delegations SET is_active = FALSE WHERE id = ?', [delegationId]);
    return res.json({ success: true, message: 'Delegation successfully revoked.' });
  } catch (err: any) {
    console.error('Error revoking delegation:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/delegation (List active delegations)
router.get('/', requireAuth, requireRole('platform-admin', 'leader'), async (_req: Request, res: Response): Promise<any> => {
  try {
    const [rows]: any = await pool.query(`
      SELECT rd.*, s.name AS student_name, s.student_code, s.room_number
      FROM role_delegations rd
      JOIN students s ON rd.student_id = s.id
      ORDER BY rd.id DESC
    `);
    return res.json({ success: true, data: rows });
  } catch (err: any) {
    console.error('Error listing delegations:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
