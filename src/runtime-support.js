'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function createRuntimeSupport(app) {
  const compatGpu = process.argv.includes('--compat-gpu');
  const diagnostics = process.argv.includes('--diagnose-performance');
  const logFile = path.join(app.getPath('userData'), 'performance-diagnostics.jsonl');
  let timer;
  const log = (event, data) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
        fs.renameSync(logFile, logFile + '.previous');
      }
      fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n');
    } catch { /* Diagnostics must never prevent editing. */ }
  };
  const patchVersion = () => app.getVersion?.() || require('../package.json').version;
  async function start() {
    log('startup', { patch: patchVersion(), compatGpu, diagnostics, electron: process.versions.electron,
      node: process.versions.node, platform: process.platform, arch: process.arch, os: os.release(),
      cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 1073741824) });
    const gpu = async () => {
      try {
        const info = await app.getGPUInfo?.('complete');
        log('gpu', { features: app.getGPUFeatureStatus?.(), devices: info?.gpuDevice?.map(device => ({
          active: device.active, vendorId: device.vendorId, deviceId: device.deviceId,
          driverVersion: device.driverVersion, driverVendor: device.driverVendor
        })) });
      } catch (error) { log('gpu-error', { code: String(error.code || 'GPU_INFO_UNAVAILABLE') }); }
    };
    if (diagnostics && app.getGPUInfo) await gpu();
    app.on('child-process-gone', (_event, detail) => log('child-process-gone', { type: detail.type, reason: detail.reason, exitCode: detail.exitCode }));
    app.on('render-process-gone', (_event, _contents, detail) => log('render-process-gone', { reason: detail.reason, exitCode: detail.exitCode }));
    if (diagnostics) {
      const delay = require('node:perf_hooks').monitorEventLoopDelay({ resolution: 20 });
      delay.enable();
      timer = setInterval(() => {
        log('metrics', { loopMaxMs: Math.round(delay.max / 1e6), loopMeanMs: Math.round(delay.mean / 1e6),
          processes: app.getAppMetrics?.().map(item => ({ pid: item.pid, type: item.type, cpu: item.cpu,
            workingSetSize: item.memory?.workingSetSize })) });
        delay.reset();
      }, 15000);
      timer.unref();
      app.on('before-quit', () => { clearInterval(timer); delay.disable(); });
    }
  }
  return { compatGpu, diagnostics, start, record: log, info: () => ({ compatGpu, diagnostics, patch: patchVersion() }) };
}
module.exports = { createRuntimeSupport };
