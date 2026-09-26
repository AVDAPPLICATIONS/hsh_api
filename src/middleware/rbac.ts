import { Request, Response, NextFunction } from 'express';

/**
 * Role-Based Access Control Middleware.
 * Grants access if user has ANY of the specified roles (or is platform-admin).
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): any => {
    if (!req.user || !req.roles) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Platform-admin always has access
    if (req.roles.includes('platform-admin')) {
      return next();
    }

    const hasPermission = allowedRoles.some(role => req.roles!.includes(role));
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
export function requireFloorAccess(req: Request, res: Response, next: NextFunction): any {
  if (req.roles?.includes('platform-admin')) {
    return next();
  }

  const requestedFloor = parseInt(req.params.floorId || req.body.floor_id || (req.query.floor_id as string), 10);
  if (isNaN(requestedFloor)) {
    return next(); // If no specific floor requested, proceed to service-level filtering
  }

  const assignedFloors = req.user?.scope?.assigned_floors || [];
  if (!assignedFloors.includes(requestedFloor)) {
    return res.status(403).json({
      success: false,
      message: `Forbidden: You do not have leadership authorization for Floor ${requestedFloor}`
    });
  }

  next();
}
