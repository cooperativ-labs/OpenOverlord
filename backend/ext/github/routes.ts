import { type Permission, PERMISSIONS } from '@overlord/auth';
import { type NextFunction, type Request, type Response, Router } from 'express';

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
    handle(req => getProjectGitHubLink(req.params.projectId), {
      requires: PERMISSIONS.PROJECT_READ
    })
  );
  router.put(
    '/projects/:projectId/link',
    handle(
      req =>
        linkProjectGitHub(req.params.projectId, {
          repoFullName: typeof req.body?.repoFullName === 'string' ? req.body.repoFullName : null
        }),
      { mutates: true, requires: PERMISSIONS.PROJECT_UPDATE }
    )
  );
  router.get(
    '/missions/:missionId/pull-request',
    handle(req => getMissionGitHubPullRequest(req.params.missionId), {
      requires: PERMISSIONS.MISSION_READ
    })
  );
  router.post(
    '/missions/:missionId/pull-request',
    handle(req => createMissionGitHubPullRequest(req.params.missionId, req.body ?? {}), {
      mutates: true,
      requires: PERMISSIONS.MISSION_UPDATE
    })
  );
  return router;
}
