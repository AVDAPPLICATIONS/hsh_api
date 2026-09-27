 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }import { Router, } from 'express';
import pool from '../../config/db';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';

const router = Router();

// Helper to compute total cost of a laundry ticket
export function computeLaundryTotal(ticket) {
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
router.post('/', requireAuth, async (req, res) => {
  try {
    let targetStudentId = _optionalChain([req, 'access', _ => _.user, 'optionalAccess', _2 => _2.student_id]) || _optionalChain([req, 'access', _3 => _3.student, 'optionalAccess', _4 => _4.id]);

    if (req.body.student_id) {
      targetStudentId = parseInt(req.body.student_id, 10);
    } else if (req.body.aadhar || req.body.bank_code || req.body.student_code || req.body.bankCode) {
      const code = String(req.body.aadhar || req.body.bank_code || req.body.student_code || req.body.bankCode);
      const [byCode] = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [code, isNaN(Number(code)) ? 0 : Number(code)]);
      if (byCode.length > 0) targetStudentId = byCode[0].id;
    }

    if (!targetStudentId) {
      return res.status(400).json({ success: false, message: 'Valid student_id is required' });
    }

    // Verify student exists
    const [students] = await pool.query('SELECT id, name, student_code, room_number, phone_number FROM students WHERE id = ?', [targetStudentId]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: `Student with ID ${targetStudentId} not found` });
    }
    const student = students[0];

    const data = req.body;
    const [insertResult] = await pool.query(
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

    const [rows] = await pool.query('SELECT * FROM laundry WHERE id = ?', [insertResult.insertId]);
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
  } catch (err) {
    console.error('Error creating laundry ticket:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry & GET /api/laundry/admin (List tickets)
router.get(['/', '/admin'], requireAuth, async (req, res) => {
  try {
    const { status, student_id, aadhar, student_code, bank_code, bankCode, room } = req.query;
    const isLaundryMan = _optionalChain([req, 'access', _5 => _5.roles, 'optionalAccess', _6 => _6.includes, 'call', _7 => _7('laundry-man')]) || _optionalChain([req, 'access', _8 => _8.roles, 'optionalAccess', _9 => _9.includes, 'call', _10 => _10('platform-admin')]);
    const studentId = _optionalChain([req, 'access', _11 => _11.user, 'optionalAccess', _12 => _12.student_id]) || _optionalChain([req, 'access', _13 => _13.student, 'optionalAccess', _14 => _14.id]);

    let query = `
      SELECT l.*, s.name AS student_name, s.student_code, s.room_number, s.phone_number,
             su.name AS processed_by_name
      FROM laundry l
      LEFT JOIN students s ON l.student_id = s.id
      LEFT JOIN staff_users su ON l.processed_by = su.id
      WHERE 1=1
    `;
    const params = [];

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
        params.push(parseInt(student_id , 10));
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
    const [rows] = await pool.query(query, params);

    const formatted = rows.map((r) => ({
      ...r,
      studentName: r.student_name,
      studentAadhar: r.student_code,
      aadhar: r.student_code,
      room: r.room_number,
      phone: r.phone_number,
      totalAmount: computeLaundryTotal(r)
    }));

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error listing laundry tickets:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/balance and /api/laundry/balance/:studentId
router.get(['/balance', '/balance/:studentId'], requireAuth, async (req, res) => {
  try {
    let targetStudentId = _optionalChain([req, 'access', _15 => _15.user, 'optionalAccess', _16 => _16.student_id]) || _optionalChain([req, 'access', _17 => _17.student, 'optionalAccess', _18 => _18.id]);
    if (req.params.studentId) {
      const p = String(req.params.studentId);
      const [byCode] = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [p, isNaN(Number(p)) ? 0 : Number(p)]);
      if (byCode.length > 0) targetStudentId = byCode[0].id;
      else targetStudentId = parseInt(p, 10);
    } else if (req.query.aadhar || req.query.student_id || req.query.bankCode || req.query.student_code) {
      const q = String(req.query.aadhar || req.query.student_id || req.query.bankCode || req.query.student_code);
      const [byCode] = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [q, isNaN(Number(q)) ? 0 : Number(q)]);
      if (byCode.length > 0) targetStudentId = byCode[0].id;
    }

    if (!targetStudentId) {
      return res.status(400).json({ success: false, message: 'Valid student ID is required' });
    }

    const [students] = await pool.query('SELECT id, student_code, name FROM students WHERE id = ?', [targetStudentId]);
    const studentCode = _optionalChain([students, 'access', _19 => _19[0], 'optionalAccess', _20 => _20.student_code]) || String(targetStudentId);

    // 1. Total Recharges
    const [rechargeRows] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total_recharged FROM laundryrecharge WHERE student_id = ?',
      [targetStudentId]
    );
    const totalRecharged = parseFloat(_optionalChain([rechargeRows, 'access', _21 => _21[0], 'optionalAccess', _22 => _22.total_recharged]) || 0);

    // 2. Total Delivered Laundry Spend
    const [tickets] = await pool.query(
      'SELECT * FROM laundry WHERE student_id = ? AND status = "received"',
      [targetStudentId]
    );
    const totalSpent = tickets.reduce((acc, t) => acc + computeLaundryTotal(t), 0);
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
  } catch (err) {
    console.error('Error fetching balance:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id , 10);
    const [rows] = await pool.query(`
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
    const isLaundryMan = _optionalChain([req, 'access', _23 => _23.roles, 'optionalAccess', _24 => _24.includes, 'call', _25 => _25('laundry-man')]) || _optionalChain([req, 'access', _26 => _26.roles, 'optionalAccess', _27 => _27.includes, 'call', _28 => _28('platform-admin')]);
    if (!isLaundryMan && ticket.student_id !== (_optionalChain([req, 'access', _29 => _29.user, 'optionalAccess', _30 => _30.student_id]) || _optionalChain([req, 'access', _31 => _31.student, 'optionalAccess', _32 => _32.id]))) {
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
  } catch (err) {
    console.error('Error getting laundry ticket:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH / PUT handler for laundry tickets
const handleUpdateLaundryTicket = async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id , 10);
    const data = req.body;

    const [existing] = await pool.query('SELECT * FROM laundry WHERE id = ?', [ticketId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Laundry ticket not found' });
    }

    const updateFields = [];
    const params = [];

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

    if (_optionalChain([req, 'access', _33 => _33.user, 'optionalAccess', _34 => _34.staff_id])) {
      updateFields.push('processed_by = ?');
      params.push(req.user.staff_id);
    }

    if (updateFields.length > 0) {
      params.push(ticketId);
      await pool.query(`UPDATE laundry SET ${updateFields.join(', ')} WHERE id = ?`, params);
    }

    const [updated] = await pool.query(`
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
  } catch (err) {
    console.error('Error updating laundry ticket:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

router.patch(['/:id', '/admin/:id', '/:id/status'], requireAuth, requireRole('laundry-man', 'platform-admin'), handleUpdateLaundryTicket);
router.put(['/:id', '/admin/:id'], requireAuth, requireRole('laundry-man', 'platform-admin'), handleUpdateLaundryTicket);

// POST /api/laundry/recharge (Record balance recharge for student)
router.post('/recharge', requireAuth, requireRole('laundry-man', 'platform-admin'), async (req, res) => {
  try {
    let { student_id, bankCode, aadhar, amount } = req.body;
    if (!student_id && (bankCode || aadhar)) {
      const code = String(bankCode || aadhar);
      const [byCode] = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [code, isNaN(Number(code)) ? 0 : Number(code)]);
      if (byCode.length > 0) student_id = byCode[0].id;
    }

    if (!student_id || !amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid student_id and positive amount are required' });
    }

    const [students] = await pool.query('SELECT id, name FROM students WHERE id = ?', [student_id]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: `Student ID ${student_id} not found` });
    }

    await pool.query(
      'INSERT INTO laundryrecharge (student_id, amount, recorded_by, time) VALUES (?, ?, ?, NOW())',
      [student_id, amount, _optionalChain([req, 'access', _35 => _35.user, 'optionalAccess', _36 => _36.staff_id]) || null]
    );

    return res.status(201).json({
      success: true,
      message: `Successfully credited ₹${amount} to student ${students[0].name}`
    });
  } catch (err) {
    console.error('Error recharging laundry:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/recharge/:bankCode
router.get('/recharge/:bankCode', requireAuth, async (req, res) => {
  try {
    const bankCode = req.params.bankCode;
    const [byCode] = await pool.query('SELECT id FROM students WHERE student_code = ? OR id = ? LIMIT 1', [bankCode, isNaN(Number(bankCode)) ? 0 : Number(bankCode)]);
    if (byCode.length === 0) return res.json({ success: true, data: [] });

    const studentId = byCode[0].id;
    const [rows] = await pool.query('SELECT * FROM laundryrecharge WHERE student_id = ? ORDER BY time DESC', [studentId]);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Error listing recharges:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;

