ntu@ip-172-31-21-149:~/message_bot$ docker compose logs --tail 40 dashboard
cmp dashboard/src/ai.js dashboard/src/routes/ai.js && echo BROKEN_AI_FILE
cmp dashboard/src/automation.js dashboard/src/routes/automation.js && echo BROKEN_AUTOMATION_FILE
.dashboard-1  | - /app/src/ai.js
dashboard-1  | - /app/server.js
dashboard-1  |     at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)
dashboard-1  |     at defaultResolveImpl (node:internal/modules/cjs/loader:1040:19)
dashboard-1  |     at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1045:22)
dashboard-1  |     at Function._load (node:internal/modules/cjs/loader:1216:25)
dashboard-1  |     at wrapModuleLoad (node:internal/modules/cjs/loader:254:19)
dashboard-1  |     at Module.require (node:internal/modules/cjs/loader:1527:12)
dashboard-1  |     at require (node:internal/modules/helpers:147:16)
dashboard-1  |     at Object.<anonymous> (/app/src/ai.js:4:11)
dashboard-1  |     at Module._compile (node:internal/modules/cjs/loader:1781:14)
dashboard-1  |     at Object..js (node:internal/modules/cjs/loader:1913:10) {
dashboard-1  |   code: 'MODULE_NOT_FOUND',
dashboard-1  |   requireStack: [ '/app/src/ai.js', '/app/server.js' ]
dashboard-1  | }
dashboard-1  |
dashboard-1  | Node.js v22.23.3
dashboard-1  | node:internal/modules/cjs/loader:1433
dashboard-1  |   throw err;
dashboard-1  |   ^
dashboard-1  |
dashboard-1  | Error: Cannot find module '../validate'
dashboard-1  | Require stack:
dashboard-1  | - /app/src/ai.js
dashboard-1  | - /app/server.js
dashboard-1  |     at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)
dashboard-1  |     at defaultResolveImpl (node:internal/modules/cjs/loader:1040:19)
dashboard-1  |     at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1045:22)
dashboard-1  |     at Function._load (node:internal/modules/cjs/loader:1216:25)
dashboard-1  |     at wrapModuleLoad (node:internal/modules/cjs/loader:254:19)
dashboard-1  |     at Module.require (node:internal/modules/cjs/loader:1527:12)
dashboard-1  |     at require (node:internal/modules/helpers:147:16)
dashboard-1  |     at Object.<anonymous> (/app/src/ai.js:4:11)
dashboard-1  |     at Module._compile (node:internal/modules/cjs/loader:1781:14)
dashboard-1  |     at Object..js (node:internal/modules/cjs/loader:1913:10) {
dashboard-1  |   code: 'MODULE_NOT_FOUND',
dashboard-1  |   requireStack: [ '/app/src/ai.js', '/app/server.js' ]
dashboard-1  | }
dashboard-1  |
dashboard-1  | Node.js v22.23.3
BROKEN_AI_FILE
dashboard/src/automation.js dashboard/src/routes/automation.js differ: byte 7420, line 166
ubuntu@ip-172-31-21-149:~/message_bot$
