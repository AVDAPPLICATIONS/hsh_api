 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }import { Router, } from 'express';
import pool from '../../config/db';
import { requireAuth } from '../../middleware/auth';

const router = Router();

// GET /api/fees/summary
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const studentId = _optionalChain([req, 'access', _2 => _2.user, 'optionalAccess', _3 => _3.student_id]) || _optionalChain([req, 'access', _4 => _4.student, 'optionalAccess', _5 => _5.id]);
    if (!studentId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const [students] = await pool.query('SELECT student_code FROM students WHERE id = ?', [studentId]);
    const studentCode = _optionalChain([students, 'access', _6 => _6[0], 'optionalAccess', _7 => _7.student_code]) || String(studentId);

    // Compute debits from studentfeedebit if table exists
    let totalFeeDebits = 0;
    try {
      const [debitRows] = await pool.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM studentfeedebit WHERE student_id = ? OR aadhar = ?',
        [studentId, studentCode]
      );
      totalFeeDebits = parseFloat(_optionalChain([debitRows, 'access', _8 => _8[0], 'optionalAccess', _9 => _9.total]) || 0);
    } catch (_) {}

    // Compute approved payments from studenttrans if table exists
    let totalApprovedPayments = 0;
    try {
      const [payRows] = await pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM studenttrans WHERE (student_id = ? OR aadhar = ?) AND status = 'approved'",
        [studentId, studentCode]
      );
      totalApprovedPayments = parseFloat(_optionalChain([payRows, 'access', _10 => _10[0], 'optionalAccess', _11 => _11.total]) || 0);
    } catch (_) {}

    // Compute deposit balance from deposit table if exists
    let depositBalance = 0;
    try {
      const [depRows] = await pool.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM deposit WHERE student_id = ? OR aadhar = ?',
        [studentId, studentCode]
      );
      depositBalance = parseFloat(_optionalChain([depRows, 'access', _12 => _12[0], 'optionalAccess', _13 => _13.total]) || 0);
    } catch (_) {}

    const netDue = Math.max(0, totalFeeDebits - totalApprovedPayments);

    return res.json({
      success: true,
      data: {
        summary: {
          aadhar: studentCode,
          studentAadhar: studentCode,
          totalFeeDebits,
          totalBilled: totalFeeDebits,
          totalApprovedPayments,
          totalApproved: totalApprovedPayments,
          totalDepositCredit: depositBalance,
          totalDepositDebit: 0,
          depositBalance,
          netDue
        }
      }
    });
  } catch (err) {
    console.error('Error fetching fee summary:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/fees/debits
router.get('/debits', requireAuth, async (req, res) => {
  try {
    const studentId = _optionalChain([req, 'access', _14 => _14.user, 'optionalAccess', _15 => _15.student_id]) || _optionalChain([req, 'access', _16 => _16.student, 'optionalAccess', _17 => _17.id]);
    let debits = [];
    try {
      const [rows] = await pool.query(
        'SELECT * FROM studentfeedebit WHERE student_id = ? ORDER BY id DESC',
        [studentId]
      );
      debits = rows;
    } catch (_) {}

    return res.json({ success: true, data: { debits } });
  } catch (err) {
    console.error('Error fetching fee debits:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/fees/payments
router.get('/payments', requireAuth, async (req, res) => {
  try {
    const studentId = _optionalChain([req, 'access', _18 => _18.user, 'optionalAccess', _19 => _19.student_id]) || _optionalChain([req, 'access', _20 => _20.student, 'optionalAccess', _21 => _21.id]);
    let payments = [];
    try {
      const [rows] = await pool.query(
        'SELECT * FROM studenttrans WHERE student_id = ? ORDER BY id DESC',
        [studentId]
      );
      payments = rows;
    } catch (_) {}

    return res.json({ success: true, data: { payments } });
  } catch (err) {
    console.error('Error fetching fee payments:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/fees/deposits
router.get('/deposits', requireAuth, async (req, res) => {
  try {
    const studentId = _optionalChain([req, 'access', _22 => _22.user, 'optionalAccess', _23 => _23.student_id]) || _optionalChain([req, 'access', _24 => _24.student, 'optionalAccess', _25 => _25.id]);
    let deposits = [];
    try {
      const [rows] = await pool.query(
        'SELECT * FROM deposit WHERE student_id = ? ORDER BY id DESC',
        [studentId]
      );
      deposits = rows;
    } catch (_) {}

    return res.json({ success: true, data: { deposits } });
  } catch (err) {
    console.error('Error fetching deposits:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
