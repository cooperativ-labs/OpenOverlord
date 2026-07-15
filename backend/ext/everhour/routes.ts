import { type Permission, PERMISSIONS } from '@overlord/auth';
import { type NextFunction, type Request, type Response, Router } from 'express';

import { missionRoute, projectRoute } from '../resource-routes.ts';

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
      projectRoute(PERMISSIONS.PROJECT_UPDATE, req =>
        linkProjectEverhour(req.params.projectId, req.body?.everhourProjectName ?? null)
      ),
      { mutates: true }
    )
  );
  router.get(
    '/projects/:projectId/link',
    handle(
      projectRoute(PERMISSIONS.PROJECT_READ, req => getProjectEverhourLink(req.params.projectId))
    )
  );
  router.get(
    '/projects/:projectId',
    handle(
      projectRoute(PERMISSIONS.PROJECT_READ, req => getProjectEverhourState(req.params.projectId))
    )
  );
  router.post(
    '/projects/:projectId/timer/start',
    handle(
      projectRoute(PERMISSIONS.PROJECT_UPDATE, req => startProjectTimer(req.params.projectId)),
      {
        mutates: true
      }
    )
  );
  router.post(
    '/projects/:projectId/timer/stop',
    handle(
      projectRoute(PERMISSIONS.PROJECT_UPDATE, req => stopProjectTimer(req.params.projectId)),
      {
        mutates: true
      }
    )
  );
  router.post(
    '/projects/:projectId/time',
    handle(
      projectRoute(PERMISSIONS.PROJECT_UPDATE, req =>
        addProjectTime(req.params.projectId, req.body)
      ),
      {
        mutates: true
      }
    )
  );
  router.patch(
    '/projects/:projectId/time/:recordId',
    handle(
      projectRoute(PERMISSIONS.PROJECT_UPDATE, req =>
        updateProjectTime(req.params.projectId, req.params.recordId, req.body)
      ),
      { mutates: true }
    )
  );
  router.delete(
    '/projects/:projectId/time/:recordId',
    handle(
      projectRoute(PERMISSIONS.PROJECT_UPDATE, req =>
        deleteProjectTime(req.params.projectId, req.params.recordId)
      ),
      { mutates: true }
    )
  );
  router.get(
    '/missions/:missionId',
    handle(
      missionRoute(PERMISSIONS.MISSION_READ, req => getMissionEverhourState(req.params.missionId))
    )
  );
  router.post(
    '/missions/:missionId/timer/start',
    handle(
      missionRoute(PERMISSIONS.MISSION_UPDATE, req => startMissionTimer(req.params.missionId)),
      {
        mutates: true
      }
    )
  );
  router.post(
    '/missions/:missionId/timer/stop',
    handle(
      missionRoute(PERMISSIONS.MISSION_UPDATE, req => stopMissionTimer(req.params.missionId)),
      {
        mutates: true
      }
    )
  );
  router.post(
    '/missions/:missionId/time',
    handle(
      missionRoute(PERMISSIONS.MISSION_UPDATE, req =>
        addMissionTime(req.params.missionId, req.body)
      ),
      {
        mutates: true
      }
    )
  );
  router.patch(
    '/missions/:missionId/time/:recordId',
    handle(
      missionRoute(PERMISSIONS.MISSION_UPDATE, req =>
        updateMissionTime(req.params.missionId, req.params.recordId, req.body)
      ),
      { mutates: true }
    )
  );
  router.delete(
    '/missions/:missionId/time/:recordId',
    handle(
      missionRoute(PERMISSIONS.MISSION_UPDATE, req =>
        deleteMissionTime(req.params.missionId, req.params.recordId)
      ),
      { mutates: true }
    )
  );

  return router;
}
