const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyStudent, verifyAdminOrFloorLeader } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for image uploads
const uploadDir = path.join(__dirname, '../public', 'uploads', 'complains');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `temp_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`);
  }
});

const upload = multer({ storage });

// GET /api/complain/categories
router.get('/categories', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT compType FROM complains WHERE compType IS NOT NULL');
    const dbCategories = rows.map(r => r.compType).filter(Boolean);
    const standardCategories = ['Electrical', 'Plumbing', 'Furniture', 'Cleaning', 'Internet', 'Other'];
    
    const allCategories = Array.from(new Set([...standardCategories, ...dbCategories])).sort();
    return res.json({ success: true, data: { categories: allCategories } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/complain
router.post('/', verifyStudent, upload.array('images', 5), async (req, res) => {
  try {
    const { room, compDesc, compType } = req.body;
    const aadhar = req.student.student_code; // using student_code/bank_code as identifier

    if (!compDesc || !compType) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const [result] = await pool.query(
      `INSERT INTO complains (room, bank_code, compDesc, compType, status, images, submitTime) VALUES (?, ?, ?, ?, 'pending', 0, NOW())`,
      [room || req.student.room_number || '', aadhar, compDesc, compType]
    );
    const complainId = result.insertId;

    if (req.files && req.files.length > 0) {
      req.files.forEach((file, index) => {
        const ext = path.extname(file.filename);
        const newFileName = `complain_${complainId}_${index}${ext}`;
        const newFilePath = path.join(uploadDir, newFileName);
        if (fs.existsSync(file.path)) {
          fs.renameSync(file.path, newFilePath);
        }
      });
      await pool.query('UPDATE complains SET images = ? WHERE id = ?', [req.files.length, complainId]);
    }

    const [complainRows] = await pool.query('SELECT * FROM complains WHERE id = ?', [complainId]);
    
    return res.status(201).json({ success: true, data: { complain: complainRows[0] } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/complain
router.get('/', verifyStudent, async (req, res) => {
  try {
    const { status, room } = req.query;
    
    let query = `
      SELECT c.*, s.name as student_name, s.phone_number 
      FROM complains c
      LEFT JOIN students s ON c.bank_code = s.student_code
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND c.status = ?`;
      params.push(status);
    }
    if (room) {
      query += ` AND c.room = ?`;
      params.push(room);
    }

    // If student, only show their complains
    if (req.student && !req.leader) { // assuming verifyStudent sets req.student
      query += ` AND c.bank_code = ?`;
      params.push(req.student.student_code);
    }

    query += ` ORDER BY c.submitTime DESC`;

    const [rows] = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/complain/:id
router.get('/:id', verifyStudent, async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.query(`
      SELECT c.*, s.name as student_name, s.phone_number 
      FROM complains c
      LEFT JOIN students s ON c.bank_code = s.student_code
      WHERE c.id = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Complain not found' });
    }

    if (req.student && !req.leader && rows[0].bank_code !== req.student.student_code) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/complain/:id
router.put('/:id', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const id = req.params.id;
    const { status, response, review } = req.body;
    
    let updateFields = [];
    let params = [];
    
    if (status !== undefined) {
      updateFields.push('status = ?');
      params.push(status);
      if (status === 'resolved') {
        updateFields.push('resolveTime = NOW()');
      } else if (status === 'reviewed') {
        updateFields.push('reviewTime = NOW()');
      }
    }
    if (response !== undefined) {
      updateFields.push('response = ?');
      params.push(response);
    }
    if (review !== undefined) {
      updateFields.push('review = ?');
      params.push(review);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    params.push(id);
    await pool.query(`UPDATE complains SET ${updateFields.join(', ')} WHERE id = ?`, params);
    
    const [rows] = await pool.query('SELECT * FROM complains WHERE id = ?', [id]);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/complain/:id
router.delete('/:id', verifyAdminOrFloorLeader, async (req, res) => {
  try {
    const id = req.params.id;
    
    // Clean up files
    try {
      const files = fs.readdirSync(uploadDir);
      const prefix = `complain_${id}_`;
      files.forEach((file) => {
        if (file.startsWith(prefix)) {
          fs.unlinkSync(path.join(uploadDir, file));
        }
      });
    } catch (e) {
      console.error(e);
    }

    await pool.query('DELETE FROM complains WHERE id = ?', [id]);
    return res.json({ success: true, message: 'Complain deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
