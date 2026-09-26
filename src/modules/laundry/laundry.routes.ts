import { Router, Request, Response } from 'express';
import pool from '../../config/db';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';

const router = Router();

// Helper to compute total cost of a laundry ticket
export function computeLaundryTotal(ticket: any): number {
  const washCount = (ticket.pants || 0) + (ticket.shirts || 0) + (ticket.tShirts || 0) + (ticket.towels || 0) + (ticket.others || 0);
  const pressCount = (ticket.pressPants || 0) + (ticket.pressShirts || 0) + (ticket.pressTShirts || 0) + (ticket.pressTowels || 0) + (ticket.pressOthers || 0);

  const washTotal = washCount * (ticket.washPrice || 4);
  const pressTotal = pressCount * (ticket.pressPrice || 4);
  const blanketTotal = (ticket.blanket || 0) * (ticket.blanketPrice || 20);
  const jacketTotal = (ticket.jacket || 0) * (ticket.jacketPrice || 20);
  const bedSheetTotal = (ticket.bedSheet || 0) * (ticket.bedSheetPrice || 8);

  return washTotal + pressTotal + blanketTotal + jacketTotal + bedSheetTotal;
}

// POST /api/laundry (Create ticket)
router.post('/', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const isLaundryMan = req.roles?.includes('laundry-man') || req.roles?.includes('platform-admin');
    let targetStudentId = req.user?.student_id || req.student?.id;

    if (isLaundryMan && req.body.student_id) {
      targetStudentId = parseInt(req.body.student_id, 10);
    }

    if (!targetStudentId) {
      return res.status(400).json({ success: false, message: 'Valid student_id is required' });
    }

    // Verify student exists
    const [students]: any = await pool.query('SELECT id FROM students WHERE id = ?', [targetStudentId]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: `Student with ID ${targetStudentId} not found` });
    }

    const data = req.body;
    const [insertResult]: any = await pool.query(
      `INSERT INTO laundry (
        student_id, pants, pressPants, shirts, pressShirts, tShirts, pressTShirts,
        towels, pressTowels, others, pressOthers, blanket, jacket, bedSheet,
        status, submitTime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [
        targetStudentId,
        data.pants || 0, data.pressPants || 0,
        data.shirts || 0, data.pressShirts || 0,
        data.tShirts || 0, data.pressTShirts || 0,
        data.towels || 0, data.pressTowels || 0,
        data.others || 0, data.pressOthers || 0,
        data.blanket || 0, data.jacket || 0, data.bedSheet || 0
      ]
    );

    const [rows]: any = await pool.query('SELECT * FROM laundry WHERE id = ?', [insertResult.insertId]);
    const created = rows[0];

    return res.status(201).json({
      success: true,
      data: {
        ...created,
        totalAmount: computeLaundryTotal(created)
      }
    });
  } catch (err: any) {
    console.error('Error creating laundry ticket:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry (List tickets)
router.get('/', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const { status, student_id } = req.query;
    const isLaundryMan = req.roles?.includes('laundry-man') || req.roles?.includes('platform-admin');
    const studentId = req.user?.student_id || req.student?.id;

    let query = `
      SELECT l.*, s.name AS student_name, s.student_code, s.room_number, s.phone_number,
             su.name AS processed_by_name
      FROM laundry l
      LEFT JOIN students s ON l.student_id = s.id
      LEFT JOIN staff_users su ON l.processed_by = su.id
      WHERE 1=1
    `;
    const params: any[] = [];

    // Students only view their own tickets
    if (!isLaundryMan) {
      query += ' AND l.student_id = ?';
      params.push(studentId);
    } else if (student_id) {
      query += ' AND l.student_id = ?';
      params.push(parseInt(student_id as string, 10));
    }

    if (status) {
      query += ' AND l.status = ?';
      params.push(status);
    }

    query += ' ORDER BY l.submitTime DESC';
    const [rows]: any = await pool.query(query, params);

    const formatted = rows.map((r: any) => ({
      ...r,
      totalAmount: computeLaundryTotal(r)
    }));

    return res.json({ success: true, data: formatted });
  } catch (err: any) {
    console.error('Error listing laundry tickets:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/:id
router.get('/:id', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const ticketId = parseInt(req.params.id as string, 10);
    const [rows]: any = await pool.query(`
      SELECT l.*, s.name AS student_name, s.student_code, s.room_number, s.phone_number,
             su.name AS processed_by_name
      FROM laundry l
      LEFT JOIN students s ON l.student_id = s.id
      LEFT JOIN staff_users su ON l.processed_by = su.id
      WHERE l.id = ?
    `, [ticketId]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Laundry ticket not found' });
    }

    const ticket = rows[0];
    const isLaundryMan = req.roles?.includes('laundry-man') || req.roles?.includes('platform-admin');
    if (!isLaundryMan && ticket.student_id !== (req.user?.student_id || req.student?.id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    return res.json({
      success: true,
      data: {
        ...ticket,
        totalAmount: computeLaundryTotal(ticket)
      }
    });
  } catch (err: any) {
    console.error('Error getting laundry ticket:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/laundry/:id/status (Transition status: pending -> accepted -> washed -> received)
router.patch('/:id/status', requireAuth, requireRole('laundry-man', 'platform-admin'), async (req: Request, res: Response): Promise<any> => {
  try {
    const ticketId = parseInt(req.params.id as string, 10);
    const { status } = req.body;
    const allowed = ['pending', 'accepted', 'washed', 'received'];

    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${allowed.join(', ')}` });
    }

    const [existing]: any = await pool.query('SELECT * FROM laundry WHERE id = ?', [ticketId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Laundry ticket not found' });
    }

    let timestampColumn = '';
    if (status === 'accepted') timestampColumn = ', acceptTime = NOW()';
    else if (status === 'washed') timestampColumn = ', washTime = NOW()';
    else if (status === 'received') timestampColumn = ', receiveTime = NOW()';

    await pool.query(
      `UPDATE laundry 
       SET status = ?, processed_by = ? ${timestampColumn}
       WHERE id = ?`,
      [status, req.user?.staff_id || null, ticketId]
    );

    const [updated]: any = await pool.query('SELECT * FROM laundry WHERE id = ?', [ticketId]);
    const ticket = updated[0];

    return res.json({
      success: true,
      message: `Ticket updated to ${status}`,
      data: {
        ...ticket,
        totalAmount: computeLaundryTotal(ticket)
      }
    });
  } catch (err: any) {
    console.error('Error updating status:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/laundry/recharge (Record balance recharge for student)
router.post('/recharge', requireAuth, requireRole('laundry-man', 'platform-admin'), async (req: Request, res: Response): Promise<any> => {
  try {
    const { student_id, amount } = req.body;
    if (!student_id || !amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid student_id and positive amount are required' });
    }

    const [students]: any = await pool.query('SELECT id, name FROM students WHERE id = ?', [student_id]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: `Student ID ${student_id} not found` });
    }

    await pool.query(
      'INSERT INTO laundryrecharge (student_id, amount, recorded_by, time) VALUES (?, ?, ?, NOW())',
      [student_id, amount, req.user?.staff_id || null]
    );

    return res.status(201).json({
      success: true,
      message: `Successfully credited ₹${amount} to student ${students[0].name}`
    });
  } catch (err: any) {
    console.error('Error recharging laundry:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/balance/:studentId (Balance inquiry)
router.get('/balance/:studentId', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const targetStudentId = parseInt(req.params.studentId as string, 10);
    const isStaff = req.roles?.some(r => ['laundry-man', 'platform-admin'].includes(r));
    if (!isStaff && targetStudentId !== (req.user?.student_id || req.student?.id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    // 1. Total Recharges
    const [rechargeRows]: any = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total_recharged FROM laundryrecharge WHERE student_id = ?',
      [targetStudentId]
    );
    const totalRecharged = parseFloat(rechargeRows[0].total_recharged);

    // 2. Total Delivered Laundry Spend
    const [tickets]: any = await pool.query(
      'SELECT * FROM laundry WHERE student_id = ? AND status = "received"',
      [targetStudentId]
    );
    const totalSpent = tickets.reduce((acc: number, t: any) => acc + computeLaundryTotal(t), 0);
    const currentBalance = totalRecharged - totalSpent;

    return res.json({
      success: true,
      data: {
        student_id: targetStudentId,
        total_recharged: totalRecharged,
        total_spent: totalSpent,
        current_balance: currentBalance
      }
    });
  } catch (err: any) {
    console.error('Error fetching balance:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
