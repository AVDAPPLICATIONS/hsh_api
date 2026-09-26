import { Router, Request, Response } from 'express';
import pool from '../../config/db';
import { requireAuth } from '../../middleware/auth';

const router = Router();

// Helper to resolve student_id from token or payload
async function resolveStudentId(req: Request, fallbackIdOrCode?: any): Promise<number | null> {
  const tokenStudentId = req.user?.student_id || req.student?.id;
  if (tokenStudentId) return Number(tokenStudentId);

  const identifier = fallbackIdOrCode || req.body?.student_id || req.body?.aadhar || req.query?.student_id;
  if (!identifier) return null;

  const idNum = Number(identifier);
  if (!isNaN(idNum) && idNum > 0) {
    const [rows]: any = await pool.query('SELECT id FROM students WHERE id = ? LIMIT 1', [idNum]);
    if (rows.length > 0) return rows[0].id;
  }

  const codeStr = String(identifier).trim();
  const [byCode]: any = await pool.query('SELECT id FROM students WHERE student_code = ? LIMIT 1', [codeStr]);
  if (byCode.length > 0) return byCode[0].id;

  return null;
}

// 1. POST /api/screen-time/ping (Student Heartbeat & Usage Delta)
router.post('/ping', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = await resolveStudentId(req, req.body.student_id);
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Valid student_id could not be resolved' });
    }

    const {
      date,
      totalScreenTimeMinutes = 0,
      nightScreenTimeMinutes = 0,
      isScreenOn = false,
      currentApp = '',
      appUsageBreakdown = [],
      deviceUuid,
      deviceModel
    } = req.body;

    const reportDate = date || new Date().toISOString().slice(0, 10);

    // Register / update device if uuid provided
    if (deviceUuid) {
      await pool.query(
        `INSERT INTO student_devices (student_id, device_uuid, device_model, last_sync_time)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE device_model = COALESCE(VALUES(device_model), device_model), last_sync_time = NOW()`,
        [studentId, deviceUuid, deviceModel || null]
      );
    }

    // Update Daily Rollup
    await pool.query(
      `INSERT INTO student_screen_time_daily 
        (student_id, date, total_screen_time_minutes, night_screen_time_minutes, is_screen_on, current_app, last_ping)
       VALUES (?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
        total_screen_time_minutes = total_screen_time_minutes + VALUES(total_screen_time_minutes),
        night_screen_time_minutes = night_screen_time_minutes + VALUES(night_screen_time_minutes),
        is_screen_on = VALUES(is_screen_on),
        current_app = VALUES(current_app),
        last_ping = NOW()`,
      [studentId, reportDate, Math.max(0, Number(totalScreenTimeMinutes) || 0), Math.max(0, Number(nightScreenTimeMinutes) || 0), Boolean(isScreenOn), currentApp]
    );

    // Update App Breakdown
    if (Array.isArray(appUsageBreakdown) && appUsageBreakdown.length > 0) {
      for (const item of appUsageBreakdown) {
        if (!item.packageName) continue;
        const pkg = String(item.packageName);
        const name = String(item.appName || pkg);
        const mins = Math.max(0, Number(item.minutes) || 0);

        if (mins > 0) {
          await pool.query(
            `INSERT INTO parental_usage_logs (student_id, date, package_name, app_name, usage_minutes, last_recorded_at)
             VALUES (?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
              app_name = VALUES(app_name),
              usage_minutes = usage_minutes + VALUES(usage_minutes),
              last_recorded_at = NOW()`,
            [studentId, reportDate, pkg, name, mins]
          );
        }
      }
    }

    // Fetch active policy to return to client
    const [policyRows]: any = await pool.query(
      'SELECT policy_version, daily_limit_minutes, bedtime_start, bedtime_end, is_locked FROM parental_policies WHERE student_id = ?',
      [studentId]
    );

    const [rulesRows]: any = await pool.query(
      'SELECT package_name, app_name, is_blocked, daily_limit_minutes FROM parental_app_rules WHERE student_id = ? AND is_blocked = TRUE',
      [studentId]
    );

    const activePolicy = policyRows.length > 0 ? policyRows[0] : {
      policy_version: 1,
      daily_limit_minutes: 0,
      bedtime_start: null,
      bedtime_end: null,
      is_locked: false
    };

    return res.json({
      success: true,
      message: 'Ping recorded successfully',
      policy: activePolicy,
      blockedPackages: rulesRows.map((r: any) => r.package_name)
    });
  } catch (error: any) {
    console.error('[ScreenTime Ping Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 2. POST /api/screen-time/inventory (Sync installed apps)
router.post('/inventory', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = await resolveStudentId(req, req.body.student_id);
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Valid student_id is required' });
    }

    const { apps } = req.body;
    if (!Array.isArray(apps)) {
      return res.status(400).json({ success: false, message: 'apps must be an array' });
    }

    for (const app of apps) {
      if (!app.packageName) continue;
      await pool.query(
        `INSERT INTO parental_app_rules (student_id, package_name, app_name, daily_limit_minutes, is_blocked)
         VALUES (?, ?, ?, 0, FALSE)
         ON DUPLICATE KEY UPDATE app_name = VALUES(app_name)`,
        [studentId, String(app.packageName), String(app.appName || app.packageName)]
      );
    }

    return res.json({ success: true, count: apps.length, message: 'App inventory synchronized' });
  } catch (error: any) {
    console.error('[ScreenTime Inventory Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 3. GET /api/screen-time/live/:studentId? (Live Status & Today Breakdown)
router.get('/live/:studentId?', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const paramId = req.params.studentId || req.query.aadhar || req.query.student_id;
    const studentId = await resolveStudentId(req, paramId);

    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID required' });
    }

    const today = new Date().toISOString().slice(0, 10);

    const [dailyRows]: any = await pool.query(
      `SELECT total_screen_time_minutes, night_screen_time_minutes, is_screen_on, current_app, last_ping,
              TIMESTAMPDIFF(MINUTE, last_ping, NOW()) AS minutes_since_ping
       FROM student_screen_time_daily 
       WHERE student_id = ? AND date = ?`,
      [studentId, today]
    );

    const [breakdownRows]: any = await pool.query(
      `SELECT package_name AS packageName, app_name AS appName, usage_minutes AS minutes
       FROM parental_usage_logs 
       WHERE student_id = ? AND date = ? 
       ORDER BY usage_minutes DESC`,
      [studentId, today]
    );

    const [policyRows]: any = await pool.query(
      'SELECT * FROM parental_policies WHERE student_id = ?',
      [studentId]
    );

    const [blockedRows]: any = await pool.query(
      'SELECT package_name FROM parental_app_rules WHERE student_id = ? AND is_blocked = TRUE',
      [studentId]
    );

    const daily = dailyRows.length > 0 ? dailyRows[0] : null;
    const isOnline = daily ? (daily.minutes_since_ping !== null && daily.minutes_since_ping <= 10) : false;

    return res.json({
      success: true,
      data: {
        studentId,
        date: today,
        isOnline,
        isScreenOn: daily ? Boolean(daily.is_screen_on) : false,
        currentApp: daily?.current_app || 'Idle',
        totalScreenTimeMinutes: daily?.total_screen_time_minutes || 0,
        nightScreenTimeMinutes: daily?.night_screen_time_minutes || 0,
        appUsageBreakdown: breakdownRows,
        policy: policyRows.length > 0 ? policyRows[0] : null,
        blockedPackages: blockedRows.map((b: any) => b.package_name)
      }
    });
  } catch (error: any) {
    console.error('[ScreenTime Live Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 4. GET /api/screen-time/history/:studentId? (Daily history)
router.get('/history/:studentId?', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const paramId = req.params.studentId || req.query.aadhar || req.query.student_id;
    const studentId = await resolveStudentId(req, paramId);

    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID required' });
    }

    const [records]: any = await pool.query(
      `SELECT date, total_screen_time_minutes, night_screen_time_minutes, current_app, last_ping
       FROM student_screen_time_daily
       WHERE student_id = ?
       ORDER BY date DESC
       LIMIT 30`,
      [studentId]
    );

    return res.json({
      success: true,
      data: {
        studentId,
        records
      }
    });
  } catch (error: any) {
    console.error('[ScreenTime History Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 5. GET /api/screen-time/students (Directory for Leaders/Admins)
router.get('/students', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : '';
    const today = new Date().toISOString().slice(0, 10);

    let query = `
      SELECT 
        s.id,
        s.name,
        s.student_code AS aadhar,
        s.room_number AS room,
        COALESCE(d.total_screen_time_minutes, 0) AS totalScreenTimeMinutes,
        COALESCE(d.night_screen_time_minutes, 0) AS nightScreenTimeMinutes,
        COALESCE(d.is_screen_on, FALSE) AS isScreenOn,
        COALESCE(d.current_app, 'Idle') AS currentApp,
        CASE WHEN d.last_ping IS NOT NULL AND TIMESTAMPDIFF(MINUTE, d.last_ping, NOW()) <= 10 THEN TRUE ELSE FALSE END AS isOnline,
        COALESCE(p.is_locked, FALSE) AS isLocked
      FROM students s
      LEFT JOIN student_screen_time_daily d ON s.id = d.student_id AND d.date = ?
      LEFT JOIN parental_policies p ON s.id = p.student_id
    `;

    const params: any[] = [today];
    if (search) {
      query += ` WHERE s.name LIKE ? OR s.student_code LIKE ? OR s.room_number LIKE ?`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY d.total_screen_time_minutes DESC, s.name ASC LIMIT 100`;

    const [students]: any = await pool.query(query, params);

    return res.json({
      success: true,
      data: {
        students
      }
    });
  } catch (error: any) {
    console.error('[ScreenTime Students List Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 6. GET /api/screen-time/policies/:studentId?
router.get('/policies/:studentId?', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const paramId = req.params.studentId || req.query.student_id;
    const studentId = await resolveStudentId(req, paramId);
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID required' });
    }

    const [policies]: any = await pool.query(
      'SELECT * FROM parental_policies WHERE student_id = ?',
      [studentId]
    );

    const [apps]: any = await pool.query(
      'SELECT id, package_name, app_name, daily_limit_minutes, is_blocked FROM parental_app_rules WHERE student_id = ? ORDER BY app_name ASC',
      [studentId]
    );

    const policy = policies.length > 0 ? policies[0] : {
      policy_version: 1,
      daily_limit_minutes: 0,
      bedtime_start: null,
      bedtime_end: null,
      is_locked: false
    };

    return res.json({
      success: true,
      data: {
        policy,
        apps
      }
    });
  } catch (error: any) {
    console.error('[ScreenTime Get Policies Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 7. PUT /api/screen-time/policies/:studentId (Update Bedtime, Daily Limit, Lock)
router.put('/policies/:studentId', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = await resolveStudentId(req, req.params.studentId);
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Valid student ID required' });
    }

    const {
      daily_limit_minutes = 0,
      bedtime_start = null,
      bedtime_end = null,
      is_locked = false
    } = req.body;

    await pool.query(
      `INSERT INTO parental_policies (student_id, policy_version, daily_limit_minutes, bedtime_start, bedtime_end, is_locked)
       VALUES (?, 1, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        policy_version = policy_version + 1,
        daily_limit_minutes = VALUES(daily_limit_minutes),
        bedtime_start = VALUES(bedtime_start),
        bedtime_end = VALUES(bedtime_end),
        is_locked = VALUES(is_locked)`,
      [studentId, Number(daily_limit_minutes) || 0, bedtime_start || null, bedtime_end || null, Boolean(is_locked)]
    );

    return res.json({ success: true, message: 'Policy updated successfully' });
  } catch (error: any) {
    console.error('[ScreenTime Update Policy Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 8. POST /api/screen-time/apps/rule (Block/Unblock App or set App limit)
router.post('/apps/rule', requireAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const { student_id, package_name, app_name, is_blocked = false, daily_limit_minutes = 0 } = req.body;
    const studentId = await resolveStudentId(req, student_id);

    if (!studentId || !package_name) {
      return res.status(400).json({ success: false, message: 'student_id and package_name are required' });
    }

    await pool.query(
      `INSERT INTO parental_app_rules (student_id, package_name, app_name, daily_limit_minutes, is_blocked)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        app_name = COALESCE(VALUES(app_name), app_name),
        daily_limit_minutes = VALUES(daily_limit_minutes),
        is_blocked = VALUES(is_blocked)`,
      [studentId, package_name, app_name || package_name, Number(daily_limit_minutes) || 0, Boolean(is_blocked)]
    );

    // Bump policy_version on student's policy so child device will fetch latest rules
    await pool.query(
      `UPDATE parental_policies SET policy_version = policy_version + 1 WHERE student_id = ?`,
      [studentId]
    );

    return res.json({ success: true, message: `App rule for ${package_name} updated successfully` });
  } catch (error: any) {
    console.error('[ScreenTime App Rule Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
