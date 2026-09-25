const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { verifyStudent } = require('../middleware/auth');

const SALT_ROUNDS = 10;

// ------------------------------------------------------------
// POST /api/auth/student/register
// Registers a student AND binds their first device_uuid.
// device_uuid is generated on the phone (flutter_secure_storage)
// and sent here on first signup.
// ------------------------------------------------------------
router.post('/student/register', async (req, res) => {
  try {
    const { student_code, name, phone_number, password, floor_id, device_uuid } = req.body;

    if (!student_code || !name || !phone_number || !password || !floor_id || !device_uuid) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const [existing] = await pool.query(
      'SELECT id FROM students WHERE student_code = ? OR phone_number = ?',
      [student_code, phone_number]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Student already registered' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const [result] = await pool.query(
      `INSERT INTO students (student_code, name, phone_number, password_hash, floor_id, device_uuid, assigned_mobile)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [student_code, name, phone_number, password_hash, floor_id, device_uuid, phone_number]
    );

    const token = jwt.sign(
      { id: result.insertId, student_code, floor_id, role: 'student' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    return res.status(201).json({ success: true, token, student_id: result.insertId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/auth/student/login
// Logs a student in AND checks their device_uuid matches the
// one bound in the DB. If it doesn't match, login is refused
// and the app should route the student to the rebind flow.
// ------------------------------------------------------------
router.post('/student/login', async (req, res) => {
  try {
    const { phone_number, password, device_uuid } = req.body;
    if (!phone_number || !password || !device_uuid) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const [rows] = await pool.query('SELECT * FROM students WHERE phone_number = ?', [phone_number]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const student = rows[0];

    const passwordOk = await bcrypt.compare(password, student.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    if (!student.device_uuid) {
      // First time login - bind this device automatically!
      await pool.query('UPDATE students SET device_uuid = ? WHERE id = ?', [device_uuid, student.id]);
      student.device_uuid = device_uuid;
    } else if (student.device_uuid !== device_uuid) {
      // Correct credentials, WRONG device -> block login, tell app to start rebind flow
      return res.status(409).json({
        success: false,
        code: 'DEVICE_MISMATCH',
        message: 'This device is not recognized. Ask your floor leader for a rebind code.'
      });
    }

    const token = jwt.sign(
      { id: student.id, student_code: student.student_code, floor_id: student.floor_id, role: 'student' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    return res.json({ success: true, token, student: {
      id: student.id, name: student.name, student_code: student.student_code, floor_id: student.floor_id
    }});
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/auth/leader/login
// ------------------------------------------------------------
router.post('/leader/login', async (req, res) => {
  try {
    const { phone_number, username, password } = req.body;
    const identifier = username || phone_number;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Missing login credentials' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM floor_leaders WHERE (username = ? OR phone_number = ?) AND is_active = TRUE', 
      [identifier, identifier]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Floor leader not found or inactive' });
    }
    const leader = rows[0];

    const passwordOk = await bcrypt.compare(password, leader.password_hash);
    if (!passwordOk && password !== leader.password_hash) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    let assignedFloors = [];
    if (leader.assigned_floors) {
      try {
        assignedFloors = typeof leader.assigned_floors === 'string' 
          ? JSON.parse(leader.assigned_floors) 
          : leader.assigned_floors;
      } catch(e) {
        assignedFloors = [leader.floor_id];
      }
    } else {
      assignedFloors = [leader.floor_id];
    }

    let assignedSessions = ['all'];
    if (leader.assigned_sessions) {
      try {
        assignedSessions = typeof leader.assigned_sessions === 'string'
          ? JSON.parse(leader.assigned_sessions)
          : leader.assigned_sessions;
      } catch(e) {
        assignedSessions = ['all'];
      }
    }

    const token = jwt.sign(
      { 
        id: leader.id, 
        username: leader.username || leader.name, 
        floor_id: assignedFloors[0] || 0, 
        assigned_floors: assignedFloors, 
        assigned_sessions: assignedSessions,
        role: 'floor_leader' 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    return res.json({ 
      success: true, 
      token, 
      leader: { 
        id: leader.id, 
        name: leader.name, 
        username: leader.username, 
        floor_id: assignedFloors[0] || 0,
        assigned_floors: assignedFloors,
        assigned_sessions: assignedSessions
      } 
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/auth/login (EXTERNAL API & SIM AUTHENTICATION)
// ------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    // Read new payload format
    const bankCode = req.body.username || req.body.bank_code;
    const simNumbers = req.body.sim_numbers || [];

    if (!bankCode) {
      return res.status(400).json({ success: false, message: 'Missing ID' });
    }

    const password = req.body.password;

    // ==========================================
    // 1. HARDCODED MAIN ADMIN LOGIN
    // ==========================================
    // Admin uses Bank Code: 172300, 173200 or "admin"
    const cleanedCode = String(bankCode).trim().replace(/^0+/, '');
    if (cleanedCode === '172300' || cleanedCode === '173200' || cleanedCode.toLowerCase() === 'admin') {
      if (!password || !String(password).trim()) {
        return res.status(400).json({ success: false, message: 'Password is required' });
      }
      const token = jwt.sign(
        { id: 9999, floor_id: 0, role: 'admin' },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );
      return res.json({
        success: true,
        data: { token, user: { role: 'ADMIN', name: 'Super Admin', floor_id: 0 } }
      });
    }

    // ==========================================
    // 2. DATABASE FLOOR LEADER LOGIN
    // ==========================================
    const [dbLeaders] = await pool.query(
      'SELECT * FROM floor_leaders WHERE (LOWER(username) = LOWER(?) OR phone_number = ?) AND is_active = TRUE',
      [String(bankCode).trim(), String(bankCode).trim()]
    );

    if (dbLeaders.length > 0) {
      const leader = dbLeaders[0];
      if (!password || !String(password).trim()) {
        return res.status(400).json({ success: false, message: 'Password is required' });
      }

      const passwordOk = await bcrypt.compare(String(password).trim(), leader.password_hash);
      if (!passwordOk && String(password).trim() !== leader.password_hash) {
        return res.status(401).json({ success: false, message: 'Incorrect password' });
      }

      let assignedFloors = [];
      if (leader.assigned_floors) {
        try {
          assignedFloors = typeof leader.assigned_floors === 'string' 
            ? JSON.parse(leader.assigned_floors) 
            : leader.assigned_floors;
        } catch(e) {
          assignedFloors = [leader.floor_id];
        }
      } else {
        assignedFloors = [leader.floor_id];
      }

      let assignedSessions = ['all'];
      if (leader.assigned_sessions) {
        try {
          assignedSessions = typeof leader.assigned_sessions === 'string'
            ? JSON.parse(leader.assigned_sessions)
            : leader.assigned_sessions;
        } catch(e) {
          assignedSessions = ['all'];
        }
      }

      const token = jwt.sign(
        { 
          id: leader.id, 
          username: leader.username || leader.name, 
          floor_id: assignedFloors[0] || 0, 
          assigned_floors: assignedFloors, 
          assigned_sessions: assignedSessions,
          role: 'floor_leader' 
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );

      return res.json({
        success: true,
        data: { 
          token, 
          user: { 
            role: 'LEADER', 
            id: leader.id,
            username: leader.username,
            name: leader.name, 
            floor_id: assignedFloors[0] || 0,
            assigned_floors: assignedFloors,
            assigned_sessions: assignedSessions
          } 
        }
      });
    }

    // ==========================================
    // 3. HARDCODED FLOOR LEADER FALLBACK LOGIN (36X90)
    // ==========================================
    let isLeader = false;
    let leaderFloorId = 0;
    
    const leaderMatch = bankCode ? String(bankCode).match(/^36(\d)90$/) : null;
    if (leaderMatch) {
      isLeader = true;
      leaderFloorId = parseInt(leaderMatch[1], 10);
    }
    
    if (isLeader) {
      if (!password || !String(password).trim()) {
        return res.status(400).json({ success: false, message: 'Password is required' });
      }
      const token = jwt.sign(
        { id: 8000 + leaderFloorId, floor_id: leaderFloorId, assigned_floors: [leaderFloorId], role: 'floor_leader' },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );
      return res.json({
        success: true,
        data: { token, user: { role: 'LEADER', name: `Floor ${leaderFloorId} Leader`, floor_id: leaderFloorId, assigned_floors: [leaderFloorId] } }
      });
    }

    // ==========================================
    // 3. HARDCODED TEST STUDENT LOGIN
    // ==========================================
    if (bankCode === '0000' || bankCode === '99999') {
      const token = jwt.sign(
        { id: 99999, student_code: bankCode, floor_id: 9, role: 'student' },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );
      return res.json({
        success: true,
        data: {
          token,
          user: { 
            role: 'STUDENT', 
            name: 'Test Student', 
            floor_id: 9,
            room: '9000',
            phone: '0000000000',
            email: 'test@student.com'
          }
        }
      });
    }

    // ==========================================
    // 4. HARDCODED MANUAL ATTENDANCE OPERATOR
    // ==========================================
    if (bankCode === '36960') {
      const token = jwt.sign(
        { id: 99998, floor_id: 0, role: 'operator' },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );
      return res.json({
        success: true,
        data: {
          token,
          user: { 
            role: 'OPERATOR', 
            name: 'Manual Operator', 
            floor_id: 0,
          }
        }
      });
    }

    // ==========================================
    // 5. REGULAR STUDENT LOGIN (FALLBACK)
    // ==========================================
    // Normalize bankCode by removing leading zeros
    const normalizedInputUsername = String(bankCode).replace(/^0+(?=\d)/, '');

    // Fetch the list of students from the AVD API
    const https = require('https');
    const apiData = await new Promise((resolve, reject) => {
      https.get('https://api.avdvvn.org/public/getStudentBasicDetails', {
        headers: { 'x-hsh-auth-token': 'aF92Kx7QmN4Lp8Vz' }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
    
    if (!apiData || !apiData.data) {
      return res.status(500).json({ success: false, message: 'Failed to fetch external API' });
    }

    // Find the student by bankCode
    const extStudent = apiData.data.find(s => 
      String(s.bankCode).replace(/^0+(?=\d)/, '') === normalizedInputUsername
    );

    if (!extStudent) {
      return res.status(401).json({ success: false, message: 'Invalid code' });
    }

    // Use the canonical bankCode from the external API from now on
    const canonicalUsername = extStudent.bankCode;

    // Calculate floor from room (e.g. 409 -> Floor 4)
    let floorId = 0;
    if (extStudent.room) {
      const roomStr = extStudent.room.toString().trim();
      if (roomStr.length === 5) {
        floorId = parseInt(roomStr.substring(0, 2)) || 0;
      } else if (roomStr.length === 4) {
        floorId = parseInt(roomStr.substring(0, 1)) || 0;
      } else if (roomStr.length === 3) {
        floorId = parseInt(roomStr.substring(0, 1)) || 0;
      }
    }

    // Check if they exist in our local database
    const [localStudents] = await pool.query(
      'SELECT * FROM students WHERE student_code IN (?, ?)', 
      [canonicalUsername, normalizedInputUsername]
    );
    let student = null;

    if (localStudents.length === 0) {
      // Auto-register them into Hostinger!
      const fullName = `${extStudent.firstName} ${extStudent.lastName}`;
      // Use canonicalUsername (which is unique) as a fallback for phone to prevent UNIQUE constraint errors
      const phone = extStudent.phone || canonicalUsername;
      const dummyHash = '$2b$10$DKYfBMxGt00SY4/kwh1yeeGZChSF6/9uvosxdWV63dJe.AUQPPME6'; // dummy 'password123'
      
      const [insertResult] = await pool.query(
        `INSERT INTO students (student_code, name, phone_number, password_hash, floor_id, device_uuid, assigned_mobile)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        [canonicalUsername, fullName, phone, dummyHash, floorId, phone]
      );
      
      student = {
        id: insertResult.insertId,
        student_code: canonicalUsername,
        name: fullName,
        floor_id: floorId,
        device_uuid: null,
        assigned_mobile: phone
      };
    } else {
      student = localStudents[0];
    }
    
    // --- SIM BINDING LOGIC REMOVED ---
    // Students can now login using just their bank code without mobile number validation
    // ---------------------------------

    // Issue JWT Token
    const token = jwt.sign(
      { id: student.id, student_code: student.student_code, floor_id: student.floor_id, role: 'student' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    return res.json({
      success: true,
      data: {
        token,
        user: { 
          role: 'STUDENT', 
          name: student.name, 
          floor_id: student.floor_id,
          room: extStudent.room || '',
          phone: extStudent.phone || '',
          email: extStudent.email || ''
        }
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again later.' });
  }
});

// ------------------------------------------------------------
// POST /api/auth/fcm-token
// Save FCM token for push notifications
// ------------------------------------------------------------
router.post('/fcm-token', verifyStudent, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Missing token' });
    }
    await pool.query('UPDATE students SET fcm_token = ? WHERE id = ?', [token, req.student.id]);
    return res.json({ success: true, message: 'FCM token saved' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/auth/auto-login
// ------------------------------------------------------------
router.post('/auto-login', async (req, res) => {
  try {
    const { sim_numbers } = req.body;
    if (!sim_numbers || !Array.isArray(sim_numbers) || sim_numbers.length === 0) {
      return res.status(400).json({ success: false, message: 'No SIM numbers provided' });
    }

    // Find any student whose assigned_mobile matches ANY of the sim_numbers
    const [students] = await pool.query('SELECT * FROM students WHERE is_active = TRUE AND assigned_mobile IS NOT NULL');
    
    let matchedStudent = null;
    for (const student of students) {
      const assignedLast10 = String(student.assigned_mobile).slice(-10);
      for (const sim of sim_numbers) {
        if (!sim) continue;
        const simLast10 = String(sim).replace(/[^0-9]/g, '').slice(-10);
        if (simLast10 === assignedLast10) {
          matchedStudent = student;
          break;
        }
      }
      if (matchedStudent) break;
    }

    if (!matchedStudent) {
      return res.status(404).json({ success: false, message: 'No matching student found' });
    }

    const token = jwt.sign(
      { id: matchedStudent.id, student_code: matchedStudent.student_code, floor_id: matchedStudent.floor_id, role: 'student' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    // Fetch the list of students from the AVD API to get room and email
    const https = require('https');
    const apiData = await new Promise((resolve, reject) => {
      https.get('https://api.avdvvn.org/public/getStudentBasicDetails', {
        headers: { 'x-hsh-auth-token': 'aF92Kx7QmN4Lp8Vz' }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
    
    let room = '';
    let email = '';
    if (apiData && apiData.data) {
      const extStudent = apiData.data.find(s => 
        String(s.bankCode).replace(/^0+(?=\d)/, '') === String(matchedStudent.student_code).replace(/^0+(?=\d)/, '')
      );
      if (extStudent) {
        room = extStudent.room || '';
        email = extStudent.email || '';
      }
    }

    return res.json({
      success: true,
      data: {
        token,
        user: { 
          role: 'STUDENT', 
          name: matchedStudent.name, 
          floor_id: matchedStudent.floor_id,
          phone: matchedStudent.phone_number,
          room: room,
          email: email
        }
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

