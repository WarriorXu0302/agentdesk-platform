/**
 * Modules barrel.
 *
 * Each module self-registers at import time. This barrel is imported by
 * src/index.ts for side effects (registry registrations, typing impl setup,
 * etc.). Core runs with an empty barrel — the registries have inline
 * fallbacks and `sqlite_master` guards.
 *
 * Default modules (ship with main, direct core import):
 *   - src/modules/typing/        → imported directly by router/delivery/container-runner
 *   - src/modules/mount-security/ → imported directly by container-runner
 *
 * Registry-based modules (installed via /add-<name> skills, pulled from the
 * `modules` branch): append imports below.
 */
// Approvals (default tier) must load before self-mod (optional) so the
// registerApprovalHandler / requestApproval symbols are bound when self-mod
// registers its handlers at import time.
import './approvals/index.js';
import './interactive/index.js';
import './scheduling/index.js';
import './permissions/index.js';
// Cancel interceptor (ADR-0042) loads AFTER permissions so the permissions
// free-text name-capture interceptor keeps priority; cancel only claims exact
// whole-message cancel tokens for a sender who has a pending question.
import './interactive/cancel.js';
import './agent-to-agent/index.js';
import './self-mod/index.js';
import './gateway-audit/index.js';
import './provider-errors/index.js';
import './classification-log/index.js';
