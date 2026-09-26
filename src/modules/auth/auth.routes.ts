import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import https from 'https';
import pool from '../../config/db';
import { verifyStudent } from '../../middleware/auth';

const router = Router();
const SALT_ROUNDS = 10;

// POST /api/auth/student/register
router.post('/student/register', async (req: Request, res: Response): Promise<any> => {
  try {
    const { student_code, name, phone_number, password, floor_id, device_uuid } = req.body;

    if (!student_code || !name || !phone_number || !password || !floor_id || !device_uuid) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const [existing]: any = await pool.query(
      'SELECT id FROM students WHERE student_code = ? OR phone_number = ?',
      [student_code, phone_number]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Student already registered' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const [result]: any = await pool.query(
      `INSERT INTO students (student_code, name, phone_number, password_hash, floor_id, device_uuid, assigned_mobile)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [student_code, name, phone_number, password_hash, floor_id, device_uuid, phone_number]
    );

    const token = jwt.sign(
      { id: result.insertId, student_code, floor_id, role: 'student' },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
    );

    return res.status(201).json({ success: true, token, student_id: result.insertId });
  } catch (err: any) {
    console.error('Error in student register:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/student/login
router.post('/student/login', async (req: Request, res: Response): Promise<any> => {
  try {
    const { phone_number, password, device_uuid } = req.body;
    if (!phone_number || !password || !device_uuid) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const [rows]: any = await pool.query('SELECT * FROM students WHERE phone_number = ?', [phone_number]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const student = rows[0];

    const passwordOk = await bcrypt.compare(password, student.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    if (!student.device_uuid) {
      await pool.query('UPDATE students SET device_uuid = ? WHERE id = ?', [device_uuid, student.id]);
      student.device_uuid = device_uuid;
    } else if (student.device_uuid !== device_uuid) {
      return res.status(409).json({
        success: false,
        code: 'DEVICE_MISMATCH',
        message: 'This device is not recognized. Ask your floor leader for a rebind code.'
      });
    }

    // Check if student has leadership assignment
    const [leadRows]: any = await pool.query(
      'SELECT role, assigned_floors, assigned_wings, assigned_rooms FROM student_leadership WHERE student_id = ? AND is_active = TRUE',
      [student.id]
    );

    const roles = ['student'];
    let leadershipInfo: any = null;
    if (leadRows.length > 0) {
      roles.push(leadRows[0].role);
      leadershipInfo = {
        role: leadRows[0].role,
        assigned_floors: typeof leadRows[0].assigned_floors === 'string' ? JSON.parse(leadRows[0].assigned_floors) : leadRows[0].assigned_floors,
        assigned_wings: typeof leadRows[0].assigned_wings === 'string' ? JSON.parse(leadRows[0].assigned_wings) : leadRows[0].assigned_wings,
        assigned_rooms: typeof leadRows[0].assigned_rooms === 'string' ? JSON.parse(leadRows[0].assigned_rooms) : leadRows[0].assigned_rooms
      };
    }

    const token = jwt.sign(
      {
        id: student.id,
        student_code: student.student_code,
        floor_id: student.floor_id,
        role: 'student',
        roles
      },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
    );

    return res.json({
      success: true,
      token,
      student: {
        id: student.id,
        name: student.name,
        student_code: student.student_code,
        floor_id: student.floor_id,
        room_number: student.room_number,
        roles,
        leadership: leadershipInfo
      }
    });
  } catch (err: any) {
    console.error('Error in student login:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/leader/login
router.post('/leader/login', async (req: Request, res: Response): Promise<any> => {
  try {
    const { phone_number, username, password } = req.body;
    const identifier = username || phone_number;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Missing login credentials' });
    }

    const [rows]: any = await pool.query(
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

    let assignedFloors: number[] = [leader.floor_id];
    if (leader.assigned_floors) {
      try {
        assignedFloors = typeof leader.assigned_floors === 'string'
          ? JSON.parse(leader.assigned_floors)
          : leader.assigned_floors;
      } catch (e) {
        assignedFloors = [leader.floor_id];
      }
    }

    let assignedSessions = ['all'];
    if (leader.assigned_sessions) {
      try {
        assignedSessions = typeof leader.assigned_sessions === 'string'
          ? JSON.parse(leader.assigned_sessions)
          : leader.assigned_sessions;
      } catch (e) {
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
      process.env.JWT_SECRET || 'secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
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
  } catch (err: any) {
    console.error('Error in leader login:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/login (MASTER UNIFIED LOGIN)
router.post('/login', async (req: Request, res: Response): Promise<any> => {
  try {
    const bankCode = req.body.username || req.body.bank_code;
    const password = req.body.password;

    if (!bankCode) {
      return res.status(400).json({ success: false, message: 'Missing ID or Username' });
    }

    // 1. HARDCODED MAIN ADMIN
    const cleanedCode = String(bankCode).trim().replace(/^0+/, '');
    if (cleanedCode === '172300' || cleanedCode === '173200' || cleanedCode.toLowerCase() === 'admin') {
      if (!password || !String(password).trim()) {
        return res.status(400).json({ success: false, message: 'Password is required' });
      }
      const token = jwt.sign(
        { id: 9999, floor_id: 0, role: 'admin', roles: ['platform-admin'] },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
      );
      return res.json({
        success: true,
        data: {
          token,
          user: { role: 'ADMIN', roles: ['platform-admin'], name: 'Super Admin', floor_id: 0 }
        }
      });
    }

    // 2. STAFF USERS TABLE (complain-solver, laundry-man, platform-admin)
    const [staffUsers]: any = await pool.query(
      'SELECT * FROM staff_users WHERE (username = ? OR phone_number = ?) AND is_active = TRUE',
      [String(bankCode).trim(), String(bankCode).trim()]
    );
    if (staffUsers.length > 0) {
      const staff = staffUsers[0];
      if (!password) {
        return res.status(400).json({ success: false, message: 'Password is required' });
      }
      const passwordOk = await bcrypt.compare(String(password).trim(), staff.password_hash);
      if (!passwordOk && String(password).trim() !== staff.password_hash) {
        return res.status(401).json({ success: false, message: 'Incorrect password' });
      }

      const token = jwt.sign(
        { id: staff.id, username: staff.username, role: staff.role, roles: [staff.role] },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
      );

      return res.json({
        success: true,
        data: {
          token,
          user: {
            role: staff.role.toUpperCase(),
            roles: [staff.role],
            id: staff.id,
            username: staff.username,
            name: staff.name,
            assigned_categories: staff.assigned_categories
          }
        }
      });
    }

    // 3. DATABASE FLOOR LEADER LOGIN
    const [dbLeaders]: any = await pool.query(
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

      let assignedFloors = [leader.floor_id];
      if (leader.assigned_floors) {
        try {
          assignedFloors = typeof leader.assigned_floors === 'string' ? JSON.parse(leader.assigned_floors) : leader.assigned_floors;
        } catch (e) {
          assignedFloors = [leader.floor_id];
        }
      }

      const token = jwt.sign(
        {
          id: leader.id,
          username: leader.username || leader.name,
          floor_id: assignedFloors[0] || 0,
          assigned_floors: assignedFloors,
          role: 'floor_leader',
          roles: ['leader']
        },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
      );

      return res.json({
        success: true,
        data: {
          token,
          user: {
            role: 'LEADER',
            roles: ['leader'],
            id: leader.id,
            username: leader.username,
            name: leader.name,
            floor_id: assignedFloors[0] || 0,
            assigned_floors: assignedFloors
          }
        }
      });
    }

    // 4. HARDCODED FLOOR LEADER FALLBACK (36X90)
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
        { id: 8000 + leaderFloorId, floor_id: leaderFloorId, assigned_floors: [leaderFloorId], role: 'floor_leader', roles: ['leader'] },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
      );
      return res.json({
        success: true,
        data: {
          token,
          user: {
            role: 'LEADER',
            roles: ['leader'],
            name: `Floor ${leaderFloorId} Leader`,
            floor_id: leaderFloorId,
            assigned_floors: [leaderFloorId]
          }
        }
      });
    }

    // 5. HARDCODED TEST STUDENT
    if (bankCode === '0000' || bankCode === '99999') {
      const token = jwt.sign(
        { id: 99999, student_code: bankCode, floor_id: 9, role: 'student', roles: ['student'] },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
      );
      return res.json({
        success: true,
        data: {
          token,
          user: {
            role: 'STUDENT',
            roles: ['student'],
            name: 'Test Student',
            floor_id: 9,
            room: '9000',
            phone: '0000000000',
            email: 'test@student.com'
          }
        }
      });
    }

    // 6. HARDCODED MANUAL ATTENDANCE OPERATOR
    if (bankCode === '36960') {
      const token = jwt.sign(
        { id: 99998, floor_id: 0, role: 'operator', roles: ['operator'] },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
      );
      return res.json({
        success: true,
        data: {
          token,
          user: { role: 'OPERATOR', roles: ['operator'], name: 'Manual Operator', floor_id: 0 }
        }
      });
    }

    // 7. REGULAR STUDENT LOGIN (DIRECT EXTERNAL AVD API CHECK)
    const rawInput = String(bankCode).trim();
    const normalizedInputUsername = rawInput.replace(/^0+(?=\d)/, '');

    // Fetch live student list directly from AVD API
    const apiData: any = await new Promise((resolve, reject) => {
      https.get('https://api.avdvvn.org/public/getStudentBasicDetails', {
        headers: { 'x-hsh-auth-token': 'aF92Kx7QmN4Lp8Vz' }
      }, (response: any) => {
        let data = '';
        response.on('data', (chunk: any) => data += chunk);
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
      return res.status(500).json({ success: false, message: 'Failed to fetch student data from AVD API' });
    }

    // Match student from external API by bankCode, phone, aadhar, or email
    const extStudent = apiData.data.find((s: any) => {
      const sBank = String(s.bankCode || '').trim();
      const sNormBank = sBank.replace(/^0+(?=\d)/, '');
      const sPhone = String(s.phone || '').trim();
      const sAadhar = String(s.aadhar || '').trim();
      const sEmail = String(s.email || '').trim().toLowerCase();

      return (
        sBank === rawInput ||
        (sNormBank && sNormBank === normalizedInputUsername) ||
        (sPhone && sPhone === rawInput) ||
        (sAadhar && sAadhar === rawInput) ||
        (sEmail && sEmail === rawInput.toLowerCase())
      );
    });

    if (!extStudent) {
      return res.status(401).json({ success: false, message: `Student ID "${rawInput}" not found on AVD server` });
    }

    const canonicalUsername = extStudent.bankCode;
    let floorId = 0;
    if (extStudent.room) {
      const roomStr = extStudent.room.toString().trim();
      if (roomStr.length >= 3) {
        floorId = parseInt(roomStr.substring(0, roomStr.length === 5 ? 2 : 1), 10) || 0;
      }
    }

    const [localStudents]: any = await pool.query(
      'SELECT * FROM students WHERE student_code IN (?, ?) LIMIT 1',
      [canonicalUsername, normalizedInputUsername]
    );

    let student: any = null;
    const fullName = `${extStudent.firstName || ''} ${extStudent.lastName || ''}`.trim() || canonicalUsername;
    const phone = extStudent.phone || canonicalUsername;
    const fatherPhone = extStudent.fatherPhone || null;
    const motherPhone = extStudent.motherPhone || null;
    const parentPhone = fatherPhone || motherPhone || null;

    if (localStudents.length === 0) {
      const dummyHash = '$2b$10$DKYfBMxGt00SY4/kwh1yeeGZChSF6/9uvosxdWV63dJe.AUQPPME6';

      const [insertResult]: any = await pool.query(
        `INSERT INTO students (student_code, name, phone_number, password_hash, floor_id, device_uuid, assigned_mobile, room_number, father_phone, mother_phone, parent_phone)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [canonicalUsername, fullName, phone, dummyHash, floorId, phone, extStudent.room || null, fatherPhone, motherPhone, parentPhone]
      );

      student = {
        id: insertResult.insertId,
        student_code: canonicalUsername,
        name: fullName,
        floor_id: floorId,
        room_number: extStudent.room || null,
        phone_number: phone
      };
    } else {
      student = localStudents[0];
      await pool.query(
        `UPDATE students 
         SET name = ?, floor_id = ?, room_number = ?, 
             father_phone = COALESCE(?, father_phone), 
             mother_phone = COALESCE(?, mother_phone), 
             parent_phone = COALESCE(?, parent_phone) 
         WHERE id = ?`,
        [fullName, floorId, extStudent.room || student.room_number, fatherPhone, motherPhone, parentPhone, student.id]
      );
      student.name = fullName;
      student.floor_id = floorId;
      student.room_number = extStudent.room || student.room_number;
    }

    // Check if this student has active leadership (leader or wing-leader)
    const [leadershipRows]: any = await pool.query(
      'SELECT role, assigned_floors, assigned_wings, assigned_rooms FROM student_leadership WHERE student_id = ? AND is_active = TRUE',
      [student.id]
    );

    const roles = ['student'];
    let leadershipData: any = null;
    if (leadershipRows.length > 0) {
      roles.push(leadershipRows[0].role);
      leadershipData = {
        role: leadershipRows[0].role,
        assigned_floors: typeof leadershipRows[0].assigned_floors === 'string' ? JSON.parse(leadershipRows[0].assigned_floors) : leadershipRows[0].assigned_floors,
        assigned_wings: typeof leadershipRows[0].assigned_wings === 'string' ? JSON.parse(leadershipRows[0].assigned_wings) : leadershipRows[0].assigned_wings,
        assigned_rooms: typeof leadershipRows[0].assigned_rooms === 'string' ? JSON.parse(leadershipRows[0].assigned_rooms) : leadershipRows[0].assigned_rooms
      };
    }

    const token = jwt.sign(
      {
        id: student.id,
        student_code: student.student_code,
        floor_id: student.floor_id,
        role: 'student',
        roles
      },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
    );

    return res.json({
      success: true,
      token,
      data: {
        token,
        user: {
          role: roles.includes('leader') ? 'LEADER' : roles.includes('wing-leader') ? 'WING_LEADER' : 'STUDENT',
          roles,
          id: student.id,
          student_id: student.id,
          student_code: student.student_code,
          name: student.name,
          floor_id: student.floor_id,
          room: extStudent.room || student.room_number || '',
          phone: extStudent.phone || student.phone_number || '',
          email: extStudent.email || '',
          leadership: leadershipData
        }
      }
    });
  } catch (err: any) {
    console.error('Error in master login:', err);
    return res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// POST /api/auth/fcm-token
router.post('/fcm-token', verifyStudent, async (req: Request, res: Response): Promise<any> => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Missing token' });
    }
    const studentId = req.student?.id || req.user?.student_id;
    await pool.query('UPDATE students SET fcm_token = ? WHERE id = ?', [token, studentId]);
    return res.json({ success: true, message: 'FCM token saved' });
  } catch (err: any) {
    console.error('Error saving FCM token:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/auto-login (SIM Detection)
router.post('/auto-login', async (req: Request, res: Response): Promise<any> => {
  try {
    const { sim_numbers } = req.body;
    if (!sim_numbers || !Array.isArray(sim_numbers) || sim_numbers.length === 0) {
      return res.status(400).json({ success: false, message: 'No SIM numbers provided' });
    }

    const [students]: any = await pool.query('SELECT * FROM students WHERE is_active = TRUE AND assigned_mobile IS NOT NULL');

    let matchedStudent: any = null;
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
      { id: matchedStudent.id, student_code: matchedStudent.student_code, floor_id: matchedStudent.floor_id, role: 'student', roles: ['student'] },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '365d' } as any
    );

    return res.json({
      success: true,
      token,
      data: {
        token,
        user: {
          role: 'STUDENT',
          roles: ['student'],
          id: matchedStudent.id,
          name: matchedStudent.name,
          floor_id: matchedStudent.floor_id,
          room: matchedStudent.room_number || '',
          phone: matchedStudent.phone_number || ''
        }
      }
    });
  } catch (err: any) {
    console.error('Error in auto-login:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
