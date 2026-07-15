import { type Permission, PERMISSIONS } from '@overlord/auth';
import { type NextFunction, type Request, type Response, Router } from 'express';

import { missionRoute, projectRoute } from '../resource-routes.ts';

import {
  beginGitHubInstall,
  completeGitHubInstall,
  createMissionGitHubPullRequest,
  disconnectGitHub,
  getGitHubIntegration,
  getMissionGitHubPullRequest,
  getProjectGitHubLink,
  linkProjectGitHub,
  listGitHubRepos
} from './service.ts';

type RouteHandler = (
  fn: (req: Request, res: Response) => unknown,
  options?: { mutates?: boolean; requires?: Permission }
) => (req: Request, res: Response, next: NextFunction) => void;

export function createGitHubExtensionRouter(handle: RouteHandler): Router {
  const router = Router();
  router.get(
    '/integration',
    handle(() => getGitHubIntegration(), { requires: PERMISSIONS.WORKSPACE_READ })
  );
  router.post(
    '/install',
    handle(() => beginGitHubInstall(), { mutates: true, requires: PERMISSIONS.WORKSPACE_UPDATE })
  );
  router.get(
    '/callback',
    handle(
      async req => {
        await completeGitHubInstall({
          installationId: String(req.query.installation_id ?? ''),
          state: typeof req.query.state === 'string' ? req.query.state : undefined
        });
        return { connected: true };
      },
      { mutates: true, requires: PERMISSIONS.WORKSPACE_UPDATE }
    )
  );
  router.delete(
    '/integration',
    handle(() => disconnectGitHub(), { mutates: true, requires: PERMISSIONS.WORKSPACE_UPDATE })
  );
  router.get(
    '/repos',
    handle(req => listGitHubRepos(typeof req.query.q === 'string' ? req.query.q : null), {
      requires: PERMISSIONS.PROJECT_READ
    })
  );
  router.get(
    '/projects/:projectId/link',
    handle(
      projectRoute(PERMISSIONS.PROJECT_READ, req => getProjectGitHubLink(req.params.projectId))
    )
  );
  router.put(
    '/projects/:projectId/link',
    handle(
      projectRoute(PERMISSIONS.PROJECT_UPDATE, req =>
        linkProjectGitHub(req.params.projectId, {
          repoFullName: typeof req.body?.repoFullName === 'string' ? req.body.repoFullName : null
        })
      ),
      { mutates: true }
    )
  );
  router.get(
    '/missions/:missionId/pull-request',
    handle(
      missionRoute(PERMISSIONS.MISSION_READ, req =>
        getMissionGitHubPullRequest(req.params.missionId)
      )
    )
  );
  router.post(
    '/missions/:missionId/pull-request',
    handle(
      missionRoute(PERMISSIONS.MISSION_UPDATE, req =>
        createMissionGitHubPullRequest(req.params.missionId, req.body ?? {})
      ),
      { mutates: true }
    )
  );
  return router;
}
