const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyStudent, verifyAdminOrFloorLeader } = require('../middleware/auth');

// Helper to compute total amount
const computeTotal = (ticket) => {
  const washCount = (ticket.pants || 0) + (ticket.shirts || 0) + (ticket.tShirts || 0) + (ticket.towels || 0) + (ticket.others || 0);
  const pressCount = (ticket.pressPants || 0) + (ticket.pressShirts || 0) + (ticket.pressTShirts || 0) + (ticket.pressTowels || 0) + (ticket.pressOthers || 0);
  
  const washTotal = washCount * (ticket.washPrice || 4);
  const pressTotal = pressCount * (ticket.pressPrice || 4);
  const jacketTotal = (ticket.jacket || 0) * (ticket.jacketPrice || 20);
  const blanketTotal = (ticket.blanket || 0) * (ticket.blanketPrice || 20);
  const bedSheetTotal = (ticket.bedSheet || 0) * (ticket.bedSheetPrice || 8);
  
  return washTotal + pressTotal + jacketTotal + blanketTotal + bedSheetTotal;
};

// POST /api/laundry
router.post('/', verifyStudent, async (req, res) => {
  try {
    const data = req.body;
    const bankCode = req.student.student_code;

    const [result] = await pool.query(`
      INSERT INTO laundry (
        bank_code, pants, pressPants, shirts, pressShirts, tShirts, pressTShirts, 
        towels, pressTowels, others, pressOthers, blanket, jacket, bedSheet, 
        status, submitTime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
    `, [
      bankCode,
      data.pants || 0, data.pressPants || 0,
      data.shirts || 0, data.pressShirts || 0,
      data.tShirts || 0, data.pressTShirts || 0,
      data.towels || 0, data.pressTowels || 0,
      data.others || 0, data.pressOthers || 0,
      data.blanket || 0, data.jacket || 0, data.bedSheet || 0
    ]);

    const [rows] = await pool.query('SELECT * FROM laundry WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry
router.get('/', verifyStudent, async (req, res) => {
  try {
    const { status, bankCode } = req.query;
    
    let query = `
      SELECT l.*, s.name as student_name, s.room_number 
      FROM laundry l
      LEFT JOIN students s ON l.bank_code = s.student_code
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND l.status = ?`;
      params.push(status);
    }
    
    // If student, restrict to their own tickets
    if (req.student && !req.leader) {
      query += ` AND l.bank_code = ?`;
      params.push(req.student.student_code);
    } else if (bankCode) {
      query += ` AND l.bank_code = ?`;
      params.push(bankCode);
    }

    query += ` ORDER BY l.submitTime DESC`;

    const [rows] = await pool.query(query, params);
    
    // Compute totals
    const formatted = rows.map(r => ({
      ...r,
      totalAmount: computeTotal(r)
    }));

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/:id
router.get('/:id', verifyStudent, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT l.*, s.name as student_name 
      FROM laundry l
      LEFT JOIN students s ON l.bank_code = s.student_code
      WHERE l.id = ?
    `, [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    if (req.student && !req.leader && rows[0].bank_code !== req.student.student_code) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const ticket = rows[0];
    ticket.totalAmount = computeTotal(ticket);

    return res.json({ success: true, data: ticket });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/laundry/:id
router.put('/:id', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const id = req.params.id;
    const data = req.body;
    
    let updateFields = [];
    let params = [];
    
    const fields = [
      'pants', 'pressPants', 'shirts', 'pressShirts', 'tShirts', 'pressTShirts',
      'towels', 'pressTowels', 'others', 'pressOthers', 'blanket', 'jacket', 'bedSheet',
      'washPrice', 'pressPrice', 'blanketPrice', 'jacketPrice', 'bedSheetPrice', 'status'
    ];

    fields.forEach(f => {
      if (data[f] !== undefined) {
        updateFields.push(`${f} = ?`);
        params.push(data[f]);
      }
    });

    if (data.status) {
      if (data.status === 'accepted') updateFields.push('acceptTime = NOW()');
      if (data.status === 'washed') updateFields.push('washTime = NOW()');
      if (data.status === 'received') updateFields.push('receiveTime = NOW()');
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    params.push(id);
    await pool.query(`UPDATE laundry SET ${updateFields.join(', ')} WHERE id = ?`, params);
    
    const [rows] = await pool.query('SELECT * FROM laundry WHERE id = ?', [id]);
    const ticket = rows[0];
    if (ticket) ticket.totalAmount = computeTotal(ticket);
    
    return res.json({ success: true, data: ticket });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/laundry/:id
router.delete('/:id', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    await pool.query('DELETE FROM laundry WHERE id = ?', [req.params.id]);
    return res.json({ success: true, message: 'Ticket deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// --- RECHARGE ---

// POST /api/laundry/recharge
router.post('/recharge', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const { bankCode, amount } = req.body;
    if (!bankCode || !amount) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    await pool.query('INSERT INTO laundryrecharge (bank_code, amount, time) VALUES (?, ?, NOW())', [bankCode, amount]);
    return res.json({ success: true, message: 'Recharge added' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/recharge/:bankCode
router.get('/recharge/:bankCode', verifyStudent, async (req, res) => {
  try {
    const bankCode = req.params.bankCode;
    if (req.student && !req.leader && bankCode !== req.student.student_code) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const [rows] = await pool.query('SELECT * FROM laundryrecharge WHERE bank_code = ? ORDER BY time DESC', [bankCode]);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/laundry/balance/:bankCode
router.get('/balance/:bankCode', verifyStudent, async (req, res) => {
  try {
    const bankCode = req.params.bankCode;
    if (req.student && !req.leader && bankCode !== req.student.student_code) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const [recharges] = await pool.query('SELECT SUM(amount) as total FROM laundryrecharge WHERE bank_code = ?', [bankCode]);
    const totalRecharges = recharges[0].total || 0;

    const [tickets] = await pool.query('SELECT * FROM laundry WHERE bank_code = ?', [bankCode]);
    const totalSpend = tickets.reduce((sum, ticket) => sum + computeTotal(ticket), 0);

    const balance = totalRecharges - totalSpend;

    return res.json({ 
      success: true, 
      data: {
        bankCode,
        totalRecharges,
        totalSpend,
        balance
      } 
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
