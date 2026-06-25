# Core Package

`@overlord/core` contains the shared protocol/service core:

- `service/` — mission, objective, protocol-session, execution-request, profile,
  project, storage, device, and change-feed service functions.
- `repository/` — host-side repository helpers used by REST surfaces.
- `types/` — generated database types from `yarn db:codegen` plus local type
  aliases.

This package gives the former root `src/` tree a named module location. It does
not define a new contract component or runtime interaction surface; callers
still use the existing Protocol, REST, CLI, Database, and Auth component
boundaries described in [`CONTRACT.md`](../../CONTRACT.md).
