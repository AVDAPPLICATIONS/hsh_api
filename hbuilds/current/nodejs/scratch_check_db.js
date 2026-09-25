require('dotenv').config();
const pool = require('./config/db');

async function checkDb() {
  try {
    const [tables] = await pool.query('SHOW TABLES');
    console.log("Tables:", tables);

    const [studentCols] = await pool.query('DESCRIBE students');
    console.log("Students Columns:", studentCols.map(c => c.Field).join(', '));
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkDb();
