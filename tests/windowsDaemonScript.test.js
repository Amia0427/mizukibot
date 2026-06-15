const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'run-bot-daemon.ps1');
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.ok(script.includes('function Wait-MainBotLockOwnership'), 'daemon should wait for main bot lock handoff');
  assert.ok(script.includes("Get-PositiveInt64Env -Name 'BOT_DAEMON_LOCK_WAIT_MS'"), 'daemon lock wait timeout should be configurable');
  assert.ok(script.includes("Get-PositiveInt64Env -Name 'BOT_DAEMON_LOCK_POLL_MS'"), 'daemon lock polling interval should be configurable');
  assert.ok(script.includes('function Archive-DaemonRedirectLogIfNeeded'), 'daemon should archive runtime logs before redirect truncates them');
  assert.ok(script.includes('archived runtime redirect log before restart'), 'daemon should log archived runtime stdout/stderr paths');
  assert.ok(script.includes("Join-Path $logDir 'bot-main-restart-state.json'"), 'daemon should persist main bot restart backoff state');
  assert.ok(script.includes("Join-Path $logDir 'bot-main-runtime-state.json'"), 'daemon should read main bot runtime heartbeat state');
  assert.ok(script.includes("Join-Path $logDir 'bot-main-exit-observations.jsonl'"), 'daemon should append structured main bot exit observations');
  assert.ok(script.includes('function Update-MainBotEarlyExitState'), 'daemon should track repeated short-lived main bot exits');
  assert.ok(script.includes('function Get-MainBotExitEvidence'), 'daemon should derive exit evidence from lock and heartbeat state');
  assert.ok(script.includes('runtime_heartbeat_lifetime'), 'daemon should use heartbeat lifetime to classify short-lived exits');
  assert.ok(script.includes('function Record-MainBotExitObservation'), 'daemon should persist stale-lock observations for later diagnosis');
  assert.ok(script.includes("Get-PositiveInt64Env -Name 'BOT_DAEMON_MAIN_EARLY_EXIT_WINDOW_MS'"), 'daemon early-exit window should be configurable');
  assert.ok(script.includes("Get-PositiveInt64Env -Name 'BOT_DAEMON_MAIN_EARLY_EXIT_MAX_RESTARTS'"), 'daemon early-exit threshold should be configurable');
  assert.ok(script.includes("Get-PositiveInt64Env -Name 'BOT_DAEMON_MAIN_EARLY_EXIT_COOLDOWN_MS'"), 'daemon early-exit cooldown should be configurable');
  assert.ok(script.includes('main bot exited repeatedly soon after startup; backoff active'), 'daemon should stop immediate restart loops after repeated early exits');
  assert.ok(script.includes('effective_runtime_ms='), 'daemon should log effective runtime evidence for outside-window decisions');
  assert.ok(script.includes('bot-main-expected-shutdown.json'), 'daemon should exempt expected main bot shutdowns from early-exit backoff');
  assert.ok(script.includes('function Get-MainHttpReverseIngressState'), 'daemon should inspect HTTP reverse ingress listener state');
  assert.ok(script.includes("Join-Path $logDir 'bot-main-port-recovery-state.json'"), 'daemon should persist HTTP reverse port recovery attempts');
  assert.ok(script.includes("Get-PositiveInt64Env -Name 'BOT_DAEMON_HTTP_REVERSE_PORT_RECOVERY_COOLDOWN_MS'"), 'HTTP reverse recovery bypass should be rate limited');
  assert.ok(
    script.includes('main bot early-exit backoff bypassed for HTTP reverse port outage'),
    'daemon should bypass early-exit backoff once when NapCat HTTP reverse port is down'
  );
  assert.ok(script.includes('$StartedProcess.Refresh()'), 'daemon should observe whether the newly started bot exits before lock handoff');
  assert.ok(script.includes("Reason = 'process_exited_before_lock'"), 'daemon should report early process exit during lock handoff');
  assert.ok(script.includes('main bot lock acquired after daemon start'), 'daemon should log successful lock handoff timing');
  assert.ok(script.includes('elapsed_ms=$($lockWait.ElapsedMs)'), 'daemon failure logs should include handoff wait duration');
  assert.ok(!script.includes('Start-Sleep -Seconds 2'), 'daemon should not use a fixed two-second lock handoff window');
  assert.ok(script.includes('function Test-ExternalPostReplyWorkerEnabled'), 'daemon should honor external post-reply worker mode');
  assert.ok(script.includes('function Test-PostReplyWorkerIdleRecycleEnabled'), 'daemon should honor explicit idle recycle mode');
  assert.ok(script.includes('function Test-ExternalPostReplyWorkerResidentExpected'), 'daemon should model resident external worker mode');
  assert.ok(script.includes('$mainBotStartedByDaemon = $false'), 'daemon should track whether this run started the main bot');
  assert.ok(script.includes('$mainBotStartedByDaemon = $true'), 'daemon should mark successful daemon-owned main bot startup');
  assert.ok(
    script.includes("main bot started by daemon; ensure external worker"),
    'daemon should start the external post-reply worker after daemon-owned main bot startup even when the queue is currently idle'
  );
  assert.ok(
    script.indexOf('$workerState = Get-WorkerRuntimeState') < script.indexOf("main bot started by daemon; ensure external worker"),
    'daemon should check for an existing worker before daemon-owned startup recovery'
  );
  assert.ok(
    script.includes("external worker expected resident; restart missing worker"),
    'daemon should restart a missing external worker in resident mode even when the queue is idle'
  );
  assert.ok(
    script.indexOf("main bot started by daemon; ensure external worker") < script.indexOf("external worker expected resident; restart missing worker"),
    'daemon-owned startup reason should remain more specific than resident-mode recovery'
  );

  console.log('windowsDaemonScript.test.js passed');
})();
