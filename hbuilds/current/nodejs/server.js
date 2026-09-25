process.env.TZ = 'Asia/Kolkata';
require('dotenv').config();
require('./services/cron');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const rebindRoutes = require('./routes/rebind');
const attendanceRoutes = require('./routes/attendance');
const adminRoutes = require('./routes/admin');
const studentsRoutes = require('./routes/students');
const floorsRoutes = require('./routes/floors');
const esp32Routes = require('./routes/esp32');
const versionRoutes = require('./routes/version');
const whatsappRoutes = require('./routes/whatsapp');
const notificationRoutes = require('./routes/notification');
const tagsRoutes = require('./routes/tags');
const leadersRoutes = require('./routes/leaders');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-hsh-auth-token']
}));
const path = require('path');
const fs = require('fs');

const apksDir = path.join(__dirname, 'public', 'apks');
if (!fs.existsSync(apksDir)) {
  fs.mkdirSync(apksDir, { recursive: true });
}

app.use(express.json());
app.use('/apks', express.static(apksDir));
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'hostel-attendance-backend' });
});

const pool = require('./config/db');
(async function runMigrations() {
  try {
    const [columns] = await pool.query(`SHOW COLUMNS FROM students LIKE 'room_number'`);
    if (columns.length === 0) {
      await pool.query(`ALTER TABLE students ADD COLUMN room_number VARCHAR(20) DEFAULT NULL`);
    }

    try { await pool.query('ALTER TABLE students ADD COLUMN is_default_present BOOLEAN DEFAULT FALSE'); } catch(e) {}
    try { await pool.query('ALTER TABLE students ADD COLUMN father_phone VARCHAR(20) DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE students ADD COLUMN mother_phone VARCHAR(20) DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE students ADD COLUMN parent_phone VARCHAR(20) DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN linked_session_key VARCHAR(50) DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN late_time TIME DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message TEXT DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message_parent TEXT DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message_student TEXT DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message_time TIME DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message_audience VARCHAR(50) DEFAULT "absent"'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN last_auto_message_date DATE NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN is_for_all_students BOOLEAN DEFAULT TRUE'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_records ADD COLUMN is_late BOOLEAN DEFAULT FALSE'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_records ADD COLUMN bank_code VARCHAR(50) NOT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_records ADD COLUMN student_name VARCHAR(100) NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE attendance_records ADD COLUMN remarks TEXT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE floors ADD COLUMN device_name VARCHAR(100) DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE floors ADD COLUMN last_seen DATETIME DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE floors ADD COLUMN current_token VARCHAR(100) DEFAULT NULL'); } catch(e) {}

    // Floor Leaders Table Migration
    await pool.query(`
      CREATE TABLE IF NOT EXISTS floor_leaders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NULL,
        name VARCHAR(100) NOT NULL,
        phone_number VARCHAR(50) DEFAULT NULL,
        password_hash VARCHAR(255) NOT NULL,
        assigned_floors JSON DEFAULT NULL,
        assigned_sessions JSON DEFAULT NULL,
        floor_id INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    try { await pool.query('ALTER TABLE floor_leaders ADD COLUMN username VARCHAR(100) UNIQUE NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE floor_leaders ADD COLUMN assigned_floors JSON DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE floor_leaders ADD COLUMN assigned_sessions JSON DEFAULT NULL'); } catch(e) {}
    try { await pool.query('ALTER TABLE floor_leaders ADD COLUMN is_active BOOLEAN DEFAULT TRUE'); } catch(e) {}
    try { await pool.query('ALTER TABLE floor_leaders MODIFY COLUMN phone_number VARCHAR(50) NULL'); } catch(e) {}

    // Floor Session Targets Migration
    await pool.query(`
      CREATE TABLE IF NOT EXISTS floor_session_targets (
        floor_id INT NOT NULL,
        session_key VARCHAR(50) NOT NULL,
        target_type VARCHAR(20) NOT NULL DEFAULT 'ALL',
        student_ids JSON,
        PRIMARY KEY (floor_id, session_key)
      )
    `);

    // Student Tags Migration
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        color VARCHAR(20) DEFAULT '#6366f1',
        is_system BOOLEAN DEFAULT FALSE,
        description VARCHAR(255) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_tag_assignments (
        student_id INT NOT NULL,
        tag_id INT NOT NULL,
        assigned_by VARCHAR(50) DEFAULT 'ADMIN',
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (student_id, tag_id)
      )
    `);

    try {
      await pool.query(`
        UPDATE student_tags 
        SET name = 'Late', description = 'Comes late to attendance' 
        WHERE name = 'Late 3+ Days'
      `);

      await pool.query(`
        INSERT INTO student_tags (id, name, color, is_system, description) VALUES
        (1, 'Regular', '#10b981', TRUE, 'Consistent daily attendance (>=75%)'),
        (2, 'Irregular', '#f59e0b', TRUE, 'Inconsistent attendance / frequent absences'),
        (3, 'Late', '#ef4444', TRUE, 'Comes late to attendance')
        ON DUPLICATE KEY UPDATE name = VALUES(name), color = VALUES(color), description = VALUES(description), is_system = TRUE
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_tag_analysis_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          student_id INT NOT NULL,
          assigned_tag VARCHAR(50) NOT NULL,
          reason TEXT,
          analyzed_days INT DEFAULT 20,
          analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX (student_id),
          INDEX (analyzed_at)
        )
      `);
    } catch(e) {}

    console.log('Database schema auto-migration successful.');
  } catch (err) {
    console.error(`Error migrating schema: ${err.message}`);
  }
})();

app.get('/api/migrate-room', async (req, res) => {
  res.send('Schema migrations now run automatically on backend startup.');
});

app.get('/api/force-cleanup', async (req, res) => {
  const pool = require('./config/db');
  const https = require('https');
  try {
    const apiData = await new Promise((resolve, reject) => {
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

    if (!apiData || !apiData.data) {
      return res.status(500).send('No data from API');
    }

    let logs = [];
    let deletedCount = 0;
    logs.push(`Total students from external API: ${apiData.data.length}`);
    
    for (const extStudent of apiData.data) {
      if (!extStudent.bankCode) continue;
      const canonicalUsername = extStudent.bankCode;
      
      const roomRaw = extStudent.room ? extStudent.room.toString().trim() : '';
      if (!roomRaw || roomRaw === 'null' || roomRaw === '') {
        const [existing] = await pool.query('SELECT id, name FROM students WHERE student_code = ?', [canonicalUsername]);
        if (existing.length > 0) {
          const sid = existing[0].id;
          logs.push(`Deleting ${existing[0].name} (Bank: ${canonicalUsername}, No Room)`);
          
          try {
            await pool.query('DELETE FROM rebind_requests WHERE student_id = ?', [sid]);
            await pool.query('DELETE FROM attendance_records WHERE TRIM(LEADING \'0\' FROM bank_code) = TRIM(LEADING \'0\' FROM ?)', [canonicalUsername]);
            await pool.query('DELETE FROM students WHERE id = ?', [sid]);
            deletedCount++;
          } catch(err) {
            logs.push(`ERROR DELETING ${canonicalUsername}: ${err.message}`);
          }
        }
      }
    }
    
    logs.push(`Cleanup complete! Successfully deleted ${deletedCount} unassigned students.`);
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM students');
    logs.push(`Total students remaining in database: ${total}`);
    
    res.type('text/plain').send(logs.join('\n'));
    
  } catch(e) {
    res.status(500).type('text/plain').send(`Fatal Error during cleanup:\n${e.stack}`);
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/rebind', rebindRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/floors', floorsRoutes);
app.use('/api/esp32', esp32Routes);
app.use('/api/version', versionRoutes);
const whatsappService = require('./services/whatsapp');
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/notification', notificationRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/leaders', leadersRoutes);

// Fallback error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Unexpected server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance backend running on http://localhost:${PORT}`);
  // Auto-connect WhatsApp if credentials exist
  whatsappService.connectWhatsApp().catch(err => console.error('Auto-connect failed:', err));
});
