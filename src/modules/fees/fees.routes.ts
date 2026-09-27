import { Router, Request, Response } from 'express';
import pool from '../../config/db';
import { requireAuth } from '../../middleware/auth';

const router = Router();

// GET /api/fees/summary
router.get('/summary', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.user?.student_id || req.student?.id;
    if (!studentId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const [students]: any = await pool.query('SELECT student_code FROM students WHERE id = ?', [studentId]);
    const studentCode = students[0]?.student_code || String(studentId);

    // Compute debits from studentfeedebit if table exists
    let totalFeeDebits = 0;
    try {
      const [debitRows]: any = await pool.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM studentfeedebit WHERE student_id = ? OR aadhar = ?',
        [studentId, studentCode]
      );
      totalFeeDebits = parseFloat(debitRows[0]?.total || 0);
    } catch (_) {}

    // Compute approved payments from studenttrans if table exists
    let totalApprovedPayments = 0;
    try {
      const [payRows]: any = await pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM studenttrans WHERE (student_id = ? OR aadhar = ?) AND status = 'approved'",
        [studentId, studentCode]
      );
      totalApprovedPayments = parseFloat(payRows[0]?.total || 0);
    } catch (_) {}

    // Compute deposit balance from deposit table if exists
    let depositBalance = 0;
    try {
      const [depRows]: any = await pool.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM deposit WHERE student_id = ? OR aadhar = ?',
        [studentId, studentCode]
      );
      depositBalance = parseFloat(depRows[0]?.total || 0);
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
  } catch (err: any) {
    console.error('Error fetching fee summary:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/fees/debits
router.get('/debits', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.user?.student_id || req.student?.id;
    let debits: any[] = [];
    try {
      const [rows]: any = await pool.query(
        'SELECT * FROM studentfeedebit WHERE student_id = ? ORDER BY id DESC',
        [studentId]
      );
      debits = rows;
    } catch (_) {}

    return res.json({ success: true, data: { debits } });
  } catch (err: any) {
    console.error('Error fetching fee debits:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/fees/payments
router.get('/payments', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.user?.student_id || req.student?.id;
    let payments: any[] = [];
    try {
      const [rows]: any = await pool.query(
        'SELECT * FROM studenttrans WHERE student_id = ? ORDER BY id DESC',
        [studentId]
      );
      payments = rows;
    } catch (_) {}

    return res.json({ success: true, data: { payments } });
  } catch (err: any) {
    console.error('Error fetching fee payments:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/fees/deposits
router.get('/deposits', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.user?.student_id || req.student?.id;
    let deposits: any[] = [];
    try {
      const [rows]: any = await pool.query(
        'SELECT * FROM deposit WHERE student_id = ? ORDER BY id DESC',
        [studentId]
      );
      deposits = rows;
    } catch (_) {}

    return res.json({ success: true, data: { deposits } });
  } catch (err: any) {
    console.error('Error fetching deposits:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
