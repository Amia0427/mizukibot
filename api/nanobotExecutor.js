// Compatibility shim for the migration package.
// The Linux bundle no longer invokes nanobot directly; all bridge calls go through
// the generic subagent executor so other child agents can be swapped in by config.
module.exports = require('./subagentExecutor');
