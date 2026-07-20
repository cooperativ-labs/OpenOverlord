Every module should adhere to the contract in CONTRACT.md. Before beginning work, read the contract. Always make a change to any module adhere to contract where possible, and where not possible, propose a change to the contract and list the impact of that change on all other modules.

Always use '===' and instead of '=='  eqeqeq
Always use '!==' and instead of '!='  eqeqeq

Feature planning documents should be saved in the planning/feature-plans directory.

In an agent-pod, be sure to use the env variable `OVERLORD_USER_TOKEN` to authenticate with the backend.

`OVERLORD_PROJECT_RESOURCES_PATHS` and other similar list-valued env variables should be comma-separated, not space-separated.