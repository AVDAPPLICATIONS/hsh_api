const express = require('express');
const router = express.Router();

// ------------------------------------------------------------
// Rebind APIs are now DEPRECATED because the app uses SIM-based authentication.
// Device UUID binding has been removed.
// ------------------------------------------------------------

router.all('*', (req, res) => {
  return res.status(410).json({ success: false, message: 'Rebinding is no longer required in the new SIM-based authentication system.' });
});

module.exports = router;
