import { type Permission, PERMISSIONS } from '@overlord/auth';
import { type NextFunction, type Request, type Response, Router } from 'express';

import {
  addMissionTime,
  addProjectTime,
  clearEverhourApiKey,
  deleteMissionTime,
  deleteProjectTime,
  getEverhourIntegration,
  getMissionEverhourState,
  getProjectEverhourLink,
  getProjectEverhourState,
  linkProjectEverhour,
  setEverhourApiKey,
  startMissionTimer,
  startProjectTimer,
  stopMissionTimer,
  stopProjectTimer,
  updateMissionTime,
  updateProjectTime
} from './service.ts';

type RouteHandler = (
  fn: (req: Request, res: Response) => unknown,
  options?: { mutates?: boolean; requires?: Permission }
) => (req: Request, res: Response, next: NextFunction) => void;

export function createEverhourExtensionRouter(handle: RouteHandler): Router {
  const router = Router();

  router.get(
    '/integration',
    handle(() => getEverhourIntegration(), { requires: PERMISSIONS.WORKSPACE_READ })
  );
  router.put(
    '/integration',
    handle(req => setEverhourApiKey(String(req.body?.apiKey ?? '')), {
      mutates: true,
      requires: PERMISSIONS.WORKSPACE_UPDATE
    })
  );
  router.delete(
    '/integration',
    handle(() => clearEverhourApiKey(), {
      mutates: true,
      requires: PERMISSIONS.WORKSPACE_UPDATE
    })
  );
  router.put(
    '/projects/:projectId/link',
    handle(
      req => linkProjectEverhour(req.params.projectId, req.body?.everhourProjectName ?? null),
      {
        mutates: true,
        requires: PERMISSIONS.PROJECT_UPDATE
      }
    )
  );
  router.get(
    '/projects/:projectId/link',
    handle(req => getProjectEverhourLink(req.params.projectId), {
      requires: PERMISSIONS.PROJECT_READ
    })
  );
  router.get(
    '/projects/:projectId',
    handle(req => getProjectEverhourState(req.params.projectId), {
      requires: PERMISSIONS.PROJECT_READ
    })
  );
  router.post(
    '/projects/:projectId/timer/start',
    handle(req => startProjectTimer(req.params.projectId), {
      mutates: true,
      requires: PERMISSIONS.PROJECT_UPDATE
    })
  );
  router.post(
    '/projects/:projectId/timer/stop',
    handle(req => stopProjectTimer(req.params.projectId), {
      mutates: true,
      requires: PERMISSIONS.PROJECT_UPDATE
    })
  );
  router.post(
    '/projects/:projectId/time',
    handle(req => addProjectTime(req.params.projectId, req.body), {
      mutates: true,
      requires: PERMISSIONS.PROJECT_UPDATE
    })
  );
  router.patch(
    '/projects/:projectId/time/:recordId',
    handle(req => updateProjectTime(req.params.projectId, req.params.recordId, req.body), {
      mutates: true,
      requires: PERMISSIONS.PROJECT_UPDATE
    })
  );
  router.delete(
    '/projects/:projectId/time/:recordId',
    handle(req => deleteProjectTime(req.params.projectId, req.params.recordId), {
      mutates: true,
      requires: PERMISSIONS.PROJECT_UPDATE
    })
  );
  router.get(
    '/missions/:missionId',
    handle(req => getMissionEverhourState(req.params.missionId), {
      requires: PERMISSIONS.MISSION_READ
    })
  );
  router.post(
    '/missions/:missionId/timer/start',
    handle(req => startMissionTimer(req.params.missionId), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  router.post(
    '/missions/:missionId/timer/stop',
    handle(req => stopMissionTimer(req.params.missionId), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  router.post(
    '/missions/:missionId/time',
    handle(req => addMissionTime(req.params.missionId, req.body), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  router.patch(
    '/missions/:missionId/time/:recordId',
    handle(req => updateMissionTime(req.params.missionId, req.params.recordId, req.body), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  router.delete(
    '/missions/:missionId/time/:recordId',
    handle(req => deleteMissionTime(req.params.missionId, req.params.recordId), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );

  return router;
}
