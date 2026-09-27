 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }

/**
 * Role-Based Access Control Middleware.
 * Grants access if user has ANY of the specified roles (or is platform-admin).
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !req.roles) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Platform-admin always has access
    if (req.roles.includes('platform-admin')) {
      return next();
    }

    const hasPermission = allowedRoles.some(role => req.roles.includes(role));
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: requires one of the following roles: [${allowedRoles.join(', ')}]`
      });
    }

    next();
  };
}

/**
 * Validates that a floor leader or wing leader has permission for a specific floor.
 */
export function requireFloorAccess(req, res, next) {
  if (_optionalChain([req, 'access', _ => _.roles, 'optionalAccess', _2 => _2.includes, 'call', _3 => _3('platform-admin')])) {
    return next();
  }

  const requestedFloor = parseInt(req.params.floorId || req.body.floor_id || (req.query.floor_id ), 10);
  if (isNaN(requestedFloor)) {
    return next(); // If no specific floor requested, proceed to service-level filtering
  }

  const assignedFloors = _optionalChain([req, 'access', _4 => _4.user, 'optionalAccess', _5 => _5.scope, 'optionalAccess', _6 => _6.assigned_floors]) || [];
  if (!assignedFloors.includes(requestedFloor)) {
    return res.status(403).json({
      success: false,
      message: `Forbidden: You do not have leadership authorization for Floor ${requestedFloor}`
    });
  }

  next();
}
