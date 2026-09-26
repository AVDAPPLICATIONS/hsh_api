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
    let targetStudentId = req.user?.student_id || req.student?.id;

    if (req.body.student_id) {
      targetStudentId = parseInt(req.body.student_id, 10);
    } else if (req.body.aadhar || req.body.bank_code || req.body.student_code || req.body.bankCode) {
      const code = String(req.body.aadhar || req.body.bank_code || req.body.student_code || req.body.bankCode);
      const [byCode]: any = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [code, isNaN(Number(code)) ? 0 : Number(code)]);
      if (byCode.length > 0) targetStudentId = byCode[0].id;
    }

    if (!targetStudentId) {
      return res.status(400).json({ success: false, message: 'Valid student_id is required' });
    }

    // Verify student exists
    const [students]: any = await pool.query('SELECT id, name, student_code, room_number, phone_number FROM students WHERE id = ?', [targetStudentId]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: `Student with ID ${targetStudentId} not found` });
    }
    const student = students[0];

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
    const totalAmount = computeLaundryTotal(created);

    const formatted = {
      ...created,
      student_name: student.name,
      studentName: student.name,
      student_code: student.student_code,
      studentAadhar: student.student_code,
      aadhar: student.student_code,
      room_number: student.room_number,
      room: student.room_number,
      phone_number: student.phone_number,
      phone: student.phone_number,
      totalAmount
    };

    return res.status(201).json({
      success: true,
      data: {
        ...formatted,
        laundry: formatted
      }
    });
  } catch (err: any) {
    console.error('Error creating laundry ticket:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry & GET /api/laundry/admin (List tickets)
router.get(['/', '/admin'], requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const { status, student_id, aadhar, student_code, bank_code, bankCode, room } = req.query;
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

    // Students only view their own tickets unless staff/admin
    if (!isLaundryMan) {
      query += ' AND l.student_id = ?';
      params.push(studentId);
    } else {
      const codeFilter = aadhar || student_code || bank_code || bankCode;
      if (codeFilter) {
        query += ' AND s.student_code = ?';
        params.push(codeFilter);
      } else if (student_id) {
        query += ' AND l.student_id = ?';
        params.push(parseInt(student_id as string, 10));
      }
      if (room) {
        query += ' AND s.room_number = ?';
        params.push(room);
      }
    }

    if (status) {
      query += ' AND l.status = ?';
      params.push(status);
    }

    query += ' ORDER BY l.submitTime DESC';
    const [rows]: any = await pool.query(query, params);

    const formatted = rows.map((r: any) => ({
      ...r,
      studentName: r.student_name,
      studentAadhar: r.student_code,
      aadhar: r.student_code,
      room: r.room_number,
      phone: r.phone_number,
      totalAmount: computeLaundryTotal(r)
    }));

    return res.json({ success: true, data: formatted });
  } catch (err: any) {
    console.error('Error listing laundry tickets:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/balance and /api/laundry/balance/:studentId
router.get(['/balance', '/balance/:studentId'], requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    let targetStudentId = req.user?.student_id || req.student?.id;
    if (req.params.studentId) {
      const p = String(req.params.studentId);
      const [byCode]: any = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [p, isNaN(Number(p)) ? 0 : Number(p)]);
      if (byCode.length > 0) targetStudentId = byCode[0].id;
      else targetStudentId = parseInt(p, 10);
    } else if (req.query.aadhar || req.query.student_id || req.query.bankCode || req.query.student_code) {
      const q = String(req.query.aadhar || req.query.student_id || req.query.bankCode || req.query.student_code);
      const [byCode]: any = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [q, isNaN(Number(q)) ? 0 : Number(q)]);
      if (byCode.length > 0) targetStudentId = byCode[0].id;
    }

    if (!targetStudentId) {
      return res.status(400).json({ success: false, message: 'Valid student ID is required' });
    }

    const [students]: any = await pool.query('SELECT id, student_code, name FROM students WHERE id = ?', [targetStudentId]);
    const studentCode = students[0]?.student_code || String(targetStudentId);

    // 1. Total Recharges
    const [rechargeRows]: any = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total_recharged FROM laundryrecharge WHERE student_id = ?',
      [targetStudentId]
    );
    const totalRecharged = parseFloat(rechargeRows[0]?.total_recharged || 0);

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
        studentAadhar: studentCode,
        aadhar: studentCode,
        bankCode: studentCode,
        total_recharged: totalRecharged,
        totalRecharges: totalRecharged,
        total_spent: totalSpent,
        totalSpend: totalSpent,
        current_balance: currentBalance,
        balance: currentBalance,
        data: {
          studentAadhar: studentCode,
          aadhar: studentCode,
          bankCode: studentCode,
          totalRecharges: totalRecharged,
          totalSpend: totalSpent,
          balance: currentBalance
        }
      }
    });
  } catch (err: any) {
    console.error('Error fetching balance:', err);
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

    const formatted = {
      ...ticket,
      studentName: ticket.student_name,
      studentAadhar: ticket.student_code,
      aadhar: ticket.student_code,
      room: ticket.room_number,
      phone: ticket.phone_number,
      totalAmount: computeLaundryTotal(ticket)
    };

    return res.json({
      success: true,
      data: {
        ...formatted,
        laundry: formatted
      }
    });
  } catch (err: any) {
    console.error('Error getting laundry ticket:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH / PUT handler for laundry tickets
const handleUpdateLaundryTicket = async (req: Request, res: Response): Promise<any> => {
  try {
    const ticketId = parseInt(req.params.id as string, 10);
    const data = req.body;

    const [existing]: any = await pool.query('SELECT * FROM laundry WHERE id = ?', [ticketId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Laundry ticket not found' });
    }

    const updateFields: string[] = [];
    const params: any[] = [];

    const allowedFields = [
      'pants', 'pressPants', 'shirts', 'pressShirts', 'tShirts', 'pressTShirts',
      'towels', 'pressTowels', 'others', 'pressOthers', 'blanket', 'jacket', 'bedSheet',
      'washPrice', 'pressPrice', 'blanketPrice', 'jacketPrice', 'bedSheetPrice', 'status'
    ];

    allowedFields.forEach((f) => {
      if (data[f] !== undefined) {
        updateFields.push(`${f} = ?`);
        params.push(data[f]);
      }
    });

    if (data.status) {
      if (data.status === 'accepted') updateFields.push('acceptTime = NOW()');
      else if (data.status === 'washed') updateFields.push('washTime = NOW()');
      else if (data.status === 'received') updateFields.push('receiveTime = NOW()');
    }

    if (req.user?.staff_id) {
      updateFields.push('processed_by = ?');
      params.push(req.user.staff_id);
    }

    if (updateFields.length > 0) {
      params.push(ticketId);
      await pool.query(`UPDATE laundry SET ${updateFields.join(', ')} WHERE id = ?`, params);
    }

    const [updated]: any = await pool.query(`
      SELECT l.*, s.name AS student_name, s.student_code, s.room_number, s.phone_number,
             su.name AS processed_by_name
      FROM laundry l
      LEFT JOIN students s ON l.student_id = s.id
      LEFT JOIN staff_users su ON l.processed_by = su.id
      WHERE l.id = ?
    `, [ticketId]);
    const ticket = updated[0];

    const formatted = {
      ...ticket,
      studentName: ticket.student_name,
      studentAadhar: ticket.student_code,
      aadhar: ticket.student_code,
      room: ticket.room_number,
      phone: ticket.phone_number,
      totalAmount: computeLaundryTotal(ticket)
    };

    return res.json({
      success: true,
      message: `Ticket updated`,
      data: {
        ...formatted,
        laundry: formatted
      }
    });
  } catch (err: any) {
    console.error('Error updating laundry ticket:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

router.patch(['/:id', '/admin/:id', '/:id/status'], requireAuth, requireRole('laundry-man', 'platform-admin'), handleUpdateLaundryTicket);
router.put(['/:id', '/admin/:id'], requireAuth, requireRole('laundry-man', 'platform-admin'), handleUpdateLaundryTicket);

// POST /api/laundry/recharge (Record balance recharge for student)
router.post('/recharge', requireAuth, requireRole('laundry-man', 'platform-admin'), async (req: Request, res: Response): Promise<any> => {
  try {
    let { student_id, bankCode, aadhar, amount } = req.body;
    if (!student_id && (bankCode || aadhar)) {
      const code = String(bankCode || aadhar);
      const [byCode]: any = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [code, isNaN(Number(code)) ? 0 : Number(code)]);
      if (byCode.length > 0) student_id = byCode[0].id;
    }

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

// GET /api/laundry/recharge/:bankCode
router.get('/recharge/:bankCode', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const bankCode = req.params.bankCode;
    const [byCode]: any = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [bankCode, isNaN(Number(bankCode)) ? 0 : Number(bankCode)]);
    if (byCode.length === 0) return res.json({ success: true, data: [] });

    const studentId = byCode[0].id;
    const [rows]: any = await pool.query('SELECT * FROM laundryrecharge WHERE student_id = ? ORDER BY time DESC', [studentId]);
    return res.json({ success: true, data: rows });
  } catch (err: any) {
    console.error('Error listing recharges:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;

