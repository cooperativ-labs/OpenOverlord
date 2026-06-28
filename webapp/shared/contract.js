/**
 * Typed API contract shared between the REST server (`server/`) and the React
 * SPA (`web/`). DTO field names are the camelCase form of the logical schema
 * columns (see database/docs/09-database-schema-contract.md). This file is
 * types only so it can be `import type`-d from either runtime without a runtime
 * dependency.
 *
 * Scope note: this build covers projects, missions, and objectives — the entities
 * the web interface lets users add and modify — plus the objective launch
 * surface: the workspace agent catalog, per-user launch configs, project launch
 * preferences, and execution-request queueing. Runner claiming/launching and
 * deliveries remain CLI-only and are intentionally absent here.
 */
export {};
//# sourceMappingURL=contract.js.map