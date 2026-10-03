import { Router, } from 'express';
import pool from '../../config/db';

const router = Router();

// Ensure MySQL tables exist on initialization
let tablesEnsured = false;
async function ensureGeofenceTables() {
  if (tablesEnsured) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS geofence_curfew_policy (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) DEFAULT 'Hostel Night Curfew',
        start_time VARCHAR(10) DEFAULT '22:00',
        end_time VARCHAR(10) DEFAULT '06:00',
        is_active BOOLEAN DEFAULT TRUE,
        enforce_phone_lock BOOLEAN DEFAULT FALSE,
        check_interval_minutes INT DEFAULT 10,
        repeat_days VARCHAR(255) DEFAULT 'Daily',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS geofence_breach_logs (
        id VARCHAR(64) PRIMARY KEY,
        student_id VARCHAR(50) NOT NULL,
        student_name VARCHAR(100) DEFAULT NULL,
        room VARCHAR(50) DEFAULT NULL,
        phone VARCHAR(50) DEFAULT NULL,
        latitude DECIMAL(10, 7) NOT NULL,
        longitude DECIMAL(10, 7) NOT NULL,
        distance_meters DECIMAL(10, 2) DEFAULT 0,
        action_taken VARCHAR(50) DEFAULT 'none',
        is_resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_student (student_id),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Insert default curfew policy if table is empty
    const [existing] = await pool.query('SELECT id FROM geofence_curfew_policy LIMIT 1');
    if (!existing || existing.length === 0) {
      await pool.query(`
        INSERT INTO geofence_curfew_policy 
          (id, name, start_time, end_time, is_active, enforce_phone_lock, check_interval_minutes, repeat_days)
        VALUES 
          ('default_curfew', 'Hostel Night Curfew', '22:00', '06:00', TRUE, FALSE, 10, 'Daily')
      `);
    }

    tablesEnsured = true;
  } catch (err) {
    console.error('[Geofence] Table migration error:', err);
  }
}

// 1. GET /api/geofence/policy
router.get('/policy', async (_req, res) => {
  try {
    await ensureGeofenceTables();
    const [rows] = await pool.query('SELECT * FROM geofence_curfew_policy LIMIT 1');
    if (rows && rows.length > 0) {
      const p = rows[0];
      return res.json({
        status: 'success',
        data: {
          id: p.id,
          name: p.name,
          startTime: p.start_time,
          endTime: p.end_time,
          isActive: Boolean(p.is_active),
          enforcePhoneLock: Boolean(p.enforce_phone_lock),
          checkIntervalMinutes: Number(p.check_interval_minutes) || 10,
          repeatDays: p.repeat_days ? p.repeat_days.split(',') : ['Daily']
        }
      });
    }

    // Default fallback
    return res.json({
      status: 'success',
      data: {
        id: 'default_curfew',
        name: 'Hostel Night Curfew',
        startTime: '22:00',
        endTime: '06:00',
        isActive: true,
        enforcePhoneLock: false,
        checkIntervalMinutes: 10,
        repeatDays: ['Daily']
      }
    });
  } catch (err) {
    console.error('[Geofence Get Policy Error]:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. POST /api/geofence/policy
router.post('/policy', async (req, res) => {
  try {
    await ensureGeofenceTables();
    const { startTime, endTime, isActive, enforcePhoneLock, checkIntervalMinutes, repeatDays } = req.body;

    const repDaysStr = Array.isArray(repeatDays) ? repeatDays.join(',') : (repeatDays || 'Daily');

    await pool.query(`
      INSERT INTO geofence_curfew_policy 
        (id, name, start_time, end_time, is_active, enforce_phone_lock, check_interval_minutes, repeat_days)
      VALUES 
        ('default_curfew', 'Hostel Night Curfew', ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        start_time = COALESCE(?, start_time),
        end_time = COALESCE(?, end_time),
        is_active = COALESCE(?, is_active),
        enforce_phone_lock = COALESCE(?, enforce_phone_lock),
        check_interval_minutes = COALESCE(?, check_interval_minutes),
        repeat_days = COALESCE(?, repeat_days)
    `, [
      startTime || '22:00',
      endTime || '06:00',
      isActive !== undefined ? Boolean(isActive) : true,
      enforcePhoneLock !== undefined ? Boolean(enforcePhoneLock) : false,
      checkIntervalMinutes ? Number(checkIntervalMinutes) : 10,
      repDaysStr,
      startTime || null,
      endTime || null,
      isActive !== undefined ? Boolean(isActive) : null,
      enforcePhoneLock !== undefined ? Boolean(enforcePhoneLock) : null,
      checkIntervalMinutes ? Number(checkIntervalMinutes) : null,
      repDaysStr || null
    ]);

    return res.json({
      status: 'success',
      message: 'Curfew geofence policy updated successfully'
    });
  } catch (err) {
    console.error('[Geofence Save Policy Error]:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// 3. GET /api/geofence/breaches
router.get('/breaches', async (_req, res) => {
  try {
    await ensureGeofenceTables();
    const [rows] = await pool.query(`
      SELECT 
        id, student_id AS studentId, student_name AS studentName, 
        room, phone, latitude, longitude, distance_meters AS distanceMeters, 
        action_taken AS actionTaken, is_resolved AS isResolved, created_at AS timestamp
      FROM geofence_breach_logs
      ORDER BY created_at DESC
      LIMIT 200
    `);

    return res.json({
      status: 'success',
      data: rows || []
    });
  } catch (err) {
    console.error('[Geofence Get Breaches Error]:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// 4. POST /api/geofence/breach
router.post('/breach', async (req, res) => {
  try {
    await ensureGeofenceTables();
    const { studentId, studentName, room, phone, latitude, longitude, distanceMeters } = req.body;

    const breachId = `breach_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    // Check if auto phone-lock is enforced in policy
    const [policyRows] = await pool.query('SELECT enforce_phone_lock FROM geofence_curfew_policy LIMIT 1');
    const autoLock = policyRows.length > 0 ? Boolean(policyRows[0].enforce_phone_lock) : false;

    let actionTaken = 'none';

    if (autoLock && studentId) {
      try {
        // Resolve student ID and lock device in parental_policies
        const [studentRows] = await pool.query(
          'SELECT id FROM students WHERE id = ? OR student_code = ? LIMIT 1',
          [studentId, studentId]
        );
        if (studentRows.length > 0) {
          const sId = studentRows[0].id;
          await pool.query(`
            INSERT INTO parental_policies (student_id, policy_version, is_locked)
            VALUES (?, 1, TRUE)
            ON DUPLICATE KEY UPDATE is_locked = TRUE, policy_version = policy_version + 1
          `, [sId]);
          actionTaken = 'phoneLocked';
        }
      } catch (lockErr) {
        console.warn('[Geofence Auto-Lock Error]:', lockErr);
      }
    }

    await pool.query(`
      INSERT INTO geofence_breach_logs 
        (id, student_id, student_name, room, phone, latitude, longitude, distance_meters, action_taken, is_resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      breachId,
      studentId || 'UNKNOWN',
      studentName || 'Student',
      room || 'N/A',
      phone || '',
      latitude,
      longitude,
      distanceMeters || 0,
      actionTaken,
      autoLock
    ]);

    return res.status(201).json({
      status: 'success',
      data: {
        id: breachId,
        studentId,
        studentName,
        room,
        phone,
        latitude,
        longitude,
        distanceMeters,
        actionTaken,
        isResolved: autoLock,
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('[Geofence Report Breach Error]:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// 5. POST /api/geofence/admin-action
router.post('/admin-action', async (req, res) => {
  try {
    await ensureGeofenceTables();
    const { breachId, studentId, action } = req.body;

    // Update breach row
    if (breachId) {
      await pool.query(`
        UPDATE geofence_breach_logs 
        SET action_taken = ?, is_resolved = TRUE
        WHERE id = ?
      `, [action || 'resolved', breachId]);
    }

    // If operator tapped Remote Lock Phone, trigger lock on student device
    if ((action === 'phoneLocked' || action === 'remoteLockPhone') && studentId) {
      try {
        const [studentRows] = await pool.query(
          'SELECT id FROM students WHERE id = ? OR student_code = ? LIMIT 1',
          [studentId, studentId]
        );
        if (studentRows.length > 0) {
          const sId = studentRows[0].id;
          await pool.query(`
            INSERT INTO parental_policies (student_id, policy_version, is_locked)
            VALUES (?, 1, TRUE)
            ON DUPLICATE KEY UPDATE is_locked = TRUE, policy_version = policy_version + 1
          `, [sId]);
        }
      } catch (lockErr) {
        console.warn('[Geofence Admin Lock Error]:', lockErr);
      }
    }

    return res.json({
      status: 'success',
      message: 'Operator action recorded successfully'
    });
  } catch (err) {
    console.error('[Geofence Admin Action Error]:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
