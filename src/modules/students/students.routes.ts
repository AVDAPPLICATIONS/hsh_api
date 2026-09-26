import { Router, Request, Response } from 'express';
import https from 'https';
import pool from '../../config/db';
import { requireAuth, verifyAdminOrFloorLeader } from '../../middleware/auth';

const router = Router();

// GET /api/students/me or /api/students/:id (Student Profile for Mobile App)
router.get(['/me', '/:id'], requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    let studentId = req.user?.student_id || req.student?.id;
    const requested = req.params.id;

    if (requested && requested !== 'me') {
      const isStaffOrLeader = req.roles?.some(r => ['platform-admin', 'leader', 'wing-leader'].includes(r));
      const [byLookup]: any = await pool.query(
        'SELECT * FROM students WHERE id = ? OR student_code = ? LIMIT 1',
        [isNaN(Number(requested)) ? 0 : Number(requested), requested]
      );
      if (byLookup.length > 0) {
        if (!isStaffOrLeader && byLookup[0].id !== studentId) {
          return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        studentId = byLookup[0].id;
      }
    }

    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID not resolved' });
    }

    const [rows]: any = await pool.query('SELECT * FROM students WHERE id = ?', [studentId]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student profile not found' });
    }

    const s = rows[0];
    const nameParts = (s.name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
    const middleName = nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '';

    const profileData = {
      aadhar: s.student_code,
      bankCode: s.student_code,
      firstName,
      middleName,
      lastName,
      fullName: s.name,
      phone: s.phone_number || '',
      whatsappNumber: s.phone_number || '',
      email: s.email || '',
      room: s.room_number || '',
      floor_id: s.floor_id,
      fatherPhone: s.father_phone || '',
      motherPhone: s.mother_phone || '',
      status: s.is_active ? 'active' : 'left'
    };

    return res.json({
      success: true,
      data: {
        student: profileData
      }
    });
  } catch (err: any) {
    console.error('Error fetching student profile:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/students/:id (Update Profile)
router.patch(['/me', '/:id'], requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    let studentId = req.user?.student_id || req.student?.id;
    const requested = req.params.id;
    if (requested && requested !== 'me') {
      const [byLookup]: any = await pool.query(
        'SELECT id FROM students WHERE id = ? OR student_code = ? LIMIT 1',
        [isNaN(Number(requested)) ? 0 : Number(requested), requested]
      );
      if (byLookup.length > 0) studentId = byLookup[0].id;
    }

    const { whatsAppNumber, phone, fatherPhone, motherPhone } = req.body;
    await pool.query(
      `UPDATE students 
       SET phone_number = COALESCE(?, phone_number),
           father_phone = COALESCE(?, father_phone),
           mother_phone = COALESCE(?, mother_phone)
       WHERE id = ?`,
      [phone || whatsAppNumber || null, fatherPhone || null, motherPhone || null, studentId]
    );

    const [rows]: any = await pool.query('SELECT * FROM students WHERE id = ?', [studentId]);
    return res.json({ success: true, data: { student: rows[0] } });
  } catch (err: any) {
    console.error('Error updating student profile:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.use(verifyAdminOrFloorLeader);

// GET /api/students/floor-targets
router.get('/floor-targets', async (req: Request, res: Response): Promise<any> => {
  try {
    const { session_key, floor_id } = req.query;
    if (!session_key || floor_id === undefined) {
      return res.status(400).json({ success: false, message: 'Missing session_key or floor_id' });
    }
    const [rows]: any = await pool.query(
      'SELECT target_type, student_ids FROM floor_session_targets WHERE floor_id = ? AND session_key = ?',
      [floor_id, session_key]
    );
    if (rows.length === 0) {
      return res.json({ success: true, data: { target_type: 'ALL', student_ids: [] } });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (err: any) {
    console.error('Error fetching floor targets:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/students/floor-targets
router.post('/floor-targets', async (req: Request, res: Response): Promise<any> => {
  try {
    const { session_key, floor_id, target_type, student_ids } = req.body;
    if (!session_key || floor_id === undefined || !target_type) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const idsJson = JSON.stringify(student_ids || []);

    await pool.query(`
      INSERT INTO floor_session_targets (floor_id, session_key, target_type, student_ids)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE target_type = VALUES(target_type), student_ids = VALUES(student_ids)
    `, [floor_id, session_key, target_type, idsJson]);

    return res.json({ success: true, message: 'Targets saved successfully' });
  } catch (err: any) {
    console.error('Error saving floor targets:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/students/sessions
router.get('/sessions', async (_req: Request, res: Response): Promise<any> => {
  try {
    const [rows]: any = await pool.query('SELECT * FROM attendance_schedules ORDER BY start_time ASC');
    return res.json({ success: true, data: rows });
  } catch (err: any) {
    console.error('Error fetching sessions:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Sync function from AVD API
export async function syncStudentsFromApi(): Promise<void> {
  try {
    const apiData: any = await new Promise((resolve, reject) => {
      https.get('https://api.avdvvn.org/public/getStudentBasicDetails', {
        headers: { 'x-hsh-auth-token': 'aF92Kx7QmN4Lp8Vz' }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    if (!apiData || !apiData.data) return;

    for (const extStudent of apiData.data) {
      if (!extStudent.bankCode) continue;
      const canonicalUsername = extStudent.bankCode;

      const roomRaw = extStudent.room ? extStudent.room.toString().trim() : '';
      const isActive = !!(roomRaw && roomRaw !== 'null' && roomRaw !== '');
      const roomValue = isActive ? roomRaw : null;

      let floorId = 0;
      if (isActive) {
        const roomStr = roomRaw;
        if (roomStr.length >= 3) {
          floorId = parseInt(roomStr.substring(0, roomStr.length === 5 ? 2 : 1), 10) || 0;
        }
      }

      const fullName = `${extStudent.firstName || ''} ${extStudent.lastName || ''}`.trim();
      const status = extStudent.status ? extStudent.status.toLowerCase() : '';
      const phone = extStudent.phone ? String(extStudent.phone).trim() : canonicalUsername;
      const fatherPhone = extStudent.fatherPhone ? String(extStudent.fatherPhone).trim() : null;
      const motherPhone = extStudent.motherPhone ? String(extStudent.motherPhone).trim() : null;
      const parentPhone = fatherPhone || motherPhone || null;
      const dummyHash = '$2b$10$DKYfBMxGt00SY4/kwh1yeeGZChSF6/9uvosxdWV63dJe.AUQPPME6';

      await pool.query(
        `INSERT IGNORE INTO students (student_code, name, phone_number, father_phone, mother_phone, parent_phone, password_hash, floor_id, room_number, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [canonicalUsername, fullName, phone, fatherPhone, motherPhone, parentPhone, dummyHash, floorId, roomValue, isActive]
      );

      if (isActive) {
        await pool.query(
          `UPDATE students 
           SET room_number = ?, name = ?, is_active = 1, floor_id = ?, father_phone = ?, mother_phone = ?, parent_phone = ?, phone_number = COALESCE(phone_number, ?) 
           WHERE student_code = ?`,
          [roomValue, fullName, floorId, fatherPhone, motherPhone, parentPhone, phone, canonicalUsername]
        );
      } else {
        if (status === 'left') {
          await pool.query(
            `UPDATE students 
             SET is_active = 0, room_number = NULL, floor_id = 0, name = ?, father_phone = ?, mother_phone = ?, parent_phone = ? 
             WHERE student_code = ?`,
            [fullName, fatherPhone, motherPhone, parentPhone, canonicalUsername]
          );
        } else {
          await pool.query(
            `UPDATE students 
             SET name = ?, father_phone = ?, mother_phone = ?, parent_phone = ?, phone_number = COALESCE(phone_number, ?) 
             WHERE student_code = ?`,
            [fullName, fatherPhone, motherPhone, parentPhone, phone, canonicalUsername]
          );
        }
      }
    }
  } catch (err: any) {
    console.error('Error syncing students from API:', err.message || err);
  }
}

// GET /api/students
router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    await syncStudentsFromApi();

    let query = 'SELECT id AS student_id, name, floor_id, student_code, phone_number, assigned_mobile, room_number, is_default_present FROM students WHERE is_active = TRUE';
    const params: any[] = [];

    if (req.leader) {
      const leaderFloors = Array.isArray(req.leader.assigned_floors) && req.leader.assigned_floors.length > 0
        ? req.leader.assigned_floors.map((f: any) => parseInt(f, 10)).filter((f: any) => !isNaN(f))
        : (req.leader.floor_id !== undefined ? [parseInt(req.leader.floor_id, 10)] : []);

      if (leaderFloors.length > 0) {
        query += ' AND floor_id IN (?)';
        params.push(leaderFloors);
      }
    }
    query += ' ORDER BY name ASC';
    const [students]: any = await pool.query(query, params);

    try {
      const [tagRows]: any = await pool.query(`
        SELECT sta.student_id, t.id as tag_id, t.name, t.color, t.is_system, t.description
        FROM student_tag_assignments sta
        JOIN student_tags t ON sta.tag_id = t.id
      `);

      const tagsMap: Record<number, any[]> = {};
      for (const tr of tagRows) {
        if (!tagsMap[tr.student_id]) tagsMap[tr.student_id] = [];
        tagsMap[tr.student_id].push({
          id: tr.tag_id,
          name: tr.name,
          color: tr.color,
          is_system: tr.is_system,
          description: tr.description
        });
      }

      const enrichedStudents = students.map((s: any) => ({
        ...s,
        tags: tagsMap[s.student_id] || []
      }));

      return res.json({ success: true, data: enrichedStudents });
    } catch (tagErr) {
      return res.json({ success: true, data: students });
    }
  } catch (err: any) {
    console.error('Error in get students:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /api/students/:id
router.delete('/:id', async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.params.id;

    if (req.leader) {
      const [students]: any = await pool.query('SELECT floor_id FROM students WHERE id = ?', [studentId]);
      if (students.length === 0 || students[0].floor_id !== req.leader.floor_id) {
        return res.status(403).json({ success: false, message: 'Not authorized to delete this student' });
      }
    }

    await pool.query('DELETE FROM rebind_requests WHERE student_id = ?', [studentId]);
    await pool.query('DELETE FROM students WHERE id = ?', [studentId]);

    return res.json({ success: true, message: 'Student deleted successfully' });
  } catch (err: any) {
    console.error('Error deleting student:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/students
router.post('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const { name, student_code, phone_number, floor_id, room_number } = req.body;
    if (!name || !student_code || !floor_id) {
      return res.status(400).json({ success: false, message: 'Name, Bank Code, and Floor are required' });
    }
    const dummyHash = '$2b$10$DKYfBMxGt00SY4/kwh1yeeGZChSF6/9uvosxdWV63dJe.AUQPPME6';

    let finalFloorId = floor_id;
    if (req.leader) {
      finalFloorId = req.leader.floor_id;
    }

    const finalPhone = phone_number || student_code;
    const finalRoom = room_number || null;

    await pool.query(
      `INSERT INTO students (student_code, name, phone_number, password_hash, floor_id, is_active, assigned_mobile, room_number)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         floor_id = VALUES(floor_id),
         is_active = 1,
         room_number = VALUES(room_number),
         assigned_mobile = VALUES(assigned_mobile),
         phone_number = VALUES(phone_number)`,
      [student_code, name, finalPhone, dummyHash, finalFloorId, finalPhone, finalRoom]
    );
    return res.json({ success: true, message: 'Student added successfully' });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Student with this Bank Code already exists' });
    }
    console.error('Error adding student:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/students/sync
router.post('/sync', async (_req: Request, res: Response): Promise<any> => {
  try {
    await syncStudentsFromApi();
    return res.json({ success: true, message: 'Students synced successfully from External API' });
  } catch (err: any) {
    console.error('Error syncing students:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/students/:id/room
router.put('/:id/room', async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.params.id;
    const { floor_id } = req.body;
    const newFloorId = (floor_id && floor_id !== 'null') ? floor_id : null;

    await pool.query('UPDATE students SET floor_id = ? WHERE id = ?', [newFloorId, studentId]);
    return res.json({ success: true, message: 'Floor assigned successfully' });
  } catch (err: any) {
    console.error('Error assigning floor:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/students/:id/mobile
router.put('/:id/mobile', async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.params.id;
    const { assigned_mobile } = req.body;
    const newMobile = (assigned_mobile && assigned_mobile.trim() !== '') ? assigned_mobile.trim() : null;

    const [result]: any = await pool.query('UPDATE students SET assigned_mobile = ? WHERE id = ?', [newMobile, studentId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: `Student ID ${studentId} not found in database` });
    }

    return res.json({ success: true, message: 'Mobile assigned successfully' });
  } catch (err: any) {
    console.error('Error assigning mobile:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/students/:id/default-attendance
router.put('/:id/default-attendance', async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.params.id;
    const { is_default_present } = req.body;

    let newVal = is_default_present;
    if (newVal === undefined) {
      const [rows]: any = await pool.query('SELECT is_default_present FROM students WHERE id = ?', [studentId]);
      if (rows.length === 0) return res.status(404).json({ success: false, message: 'Student not found' });
      newVal = !rows[0].is_default_present;
    }

    await pool.query('UPDATE students SET is_default_present = ? WHERE id = ?', [newVal ? 1 : 0, studentId]);

    return res.json({
      success: true,
      is_default_present: !!newVal,
      message: `Default attendance set to ${newVal ? 'ON (Auto-Mark Present)' : 'OFF'}`
    });
  } catch (err: any) {
    console.error('Error updating default attendance:', err);
    return res.status(500).json({ success: false, message: 'Server error: ' + (err.sqlMessage || err.message) });
  }
});

export default router;
