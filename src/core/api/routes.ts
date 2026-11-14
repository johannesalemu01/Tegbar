import { MODULES } from '../../app.js';
import { ApiRouter } from './router.js';

/** Build the router from every module's api() registration. */
export function buildApiRouter(): ApiRouter {
  const router = new ApiRouter();
  for (const m of MODULES) m.api?.(router);
  return router;
}
