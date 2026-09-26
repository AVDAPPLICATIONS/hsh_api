import { Router, Request, Response } from 'express';

const router = Router();

router.all('*', (_req: Request, res: Response) => {
  return res.status(410).json({
    success: false,
    message: 'Rebinding is no longer required in the new SIM-based authentication system.'
  });
});

export default router;
