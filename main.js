const utils = require("@iobroker/adapter-core");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

let child = null;
let stopping = false;

function startAdapter(options) {
  return new utils.Adapter({
    ...options,
    name: "go2rtc-host",
    ready: () => {
      void main().catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        adapter.log.error(message);
        await setStatus("error", Boolean(child), message);
      });
    },
    stateChange: (id, state) => onStateChange(id, state),
    unload: (callback) => {
      stopping = true;
      stopGo2rtc("adapter unload")
        .catch(() => undefined)
        .finally(() => callback());
    },
  });
}

const adapter = startAdapter();

async function main() {
  await ensureObjects();
  await setStatus("stopped", false, "Adapter started");
  await adapter.subscribeStatesAsync("control.*");

  if (adapter.config.autoStart) {
    await startGo2rtc("autoStart");
  }
}

async function onStateChange(id, state) {
  if (!state || state.ack) {
    return;
  }

  if (!id.startsWith(`${adapter.namespace}.control.`)) {
    return;
  }

  const command = id.slice(`${adapter.namespace}.control.`.length);

  try {
    if (command === "start" && state.val === true) {
      await adapter.setStateAsync("control.start", false, true);
      await startGo2rtc("manual start");
      return;
    }

    if (command === "stop" && state.val === true) {
      await adapter.setStateAsync("control.stop", false, true);
      await stopGo2rtc("manual stop");
      return;
    }

    if (command === "restart" && state.val === true) {
      await adapter.setStateAsync("control.restart", false, true);
      await restartGo2rtc();
      return;
    }

    if (command === "install" && state.val === true) {
      await adapter.setStateAsync("control.install", false, true);
      await installBinary();
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    adapter.log.error(`Command ${command} failed: ${message}`);
    await setStatus("error", Boolean(child), message);
  }
}

function parseExtraArgs(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return [];
  }
  return raw.split(/\s+/g).filter(Boolean);
}

async function startGo2rtc(reason) {
  if (child) {
    adapter.log.info("go2rtc is already running");
    await setStatus("running", true, "Already running");
    return;
  }

  const binaryPath = String(adapter.config.binaryPath || "").trim();
  const configPath = String(adapter.config.configPath || "").trim();
  const workingDir = String(adapter.config.workingDir || "").trim() || path.dirname(binaryPath);

  if (!binaryPath || !configPath) {
    throw new Error("binaryPath and configPath must be configured");
  }

  await fsp.mkdir(workingDir, { recursive: true });

  if (!fs.existsSync(binaryPath)) {
    if (adapter.config.autoDownload) {
      await installBinary();
    } else {
      throw new Error(`go2rtc binary not found at ${binaryPath}`);
    }
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`go2rtc config not found at ${configPath}`);
  }

  await fsp.chmod(binaryPath, 0o755).catch(() => undefined);

  const args = ["-config", configPath, ...parseExtraArgs(adapter.config.extraArgs)];
  adapter.log.info(`Starting go2rtc (${reason}) with: ${binaryPath} ${args.join(" ")}`);

  const proc = spawn(binaryPath, args, {
    cwd: workingDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;

  proc.stdout.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) {
      adapter.log.info(`[go2rtc] ${line}`);
      void adapter.setStateAsync("status.lastLog", line, true);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) {
      adapter.log.warn(`[go2rtc] ${line}`);
      void adapter.setStateAsync("status.lastError", line, true);
    }
  });

  proc.once("exit", (code, signal) => {
    const expected = stopping;
    child = null;
    const message = `go2rtc exited (code=${code ?? "null"}, signal=${signal || "none"})`;
    adapter.log.warn(message);
    void setStatus(expected ? "stopped" : "error", false, message);

    if (!stopping && adapter.config.autoStart) {
      const restartMs = 3000;
      adapter.log.info(`Restarting go2rtc in ${restartMs}ms`);
      setTimeout(() => {
        void startGo2rtc("auto-restart").catch((error) => {
          const text = error instanceof Error ? error.message : String(error);
          void setStatus("error", false, text);
          adapter.log.error(`Auto-restart failed: ${text}`);
        });
      }, restartMs);
    }
  });

  await setStatus("running", true, "go2rtc running");
  await adapter.setStateAsync("status.pid", proc.pid || 0, true);
}

async function stopGo2rtc(reason) {
  if (!child) {
    await setStatus("stopped", false, "Already stopped");
    return;
  }

  adapter.log.info(`Stopping go2rtc (${reason})`);
  stopping = true;

  const current = child;
  await new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      resolve();
    };

    const forceTimer = setTimeout(() => {
      if (current.exitCode == null) {
        current.kill("SIGKILL");
      }
    }, 5000);

    current.once("exit", () => {
      clearTimeout(forceTimer);
      finish();
    });

    current.kill("SIGTERM");
  });

  stopping = false;
  await setStatus("stopped", false, "go2rtc stopped");
  await adapter.setStateAsync("status.pid", 0, true);
}

async function restartGo2rtc() {
  await stopGo2rtc("restart");
  await startGo2rtc("restart");
}

async function installBinary() {
  const targetPath = String(adapter.config.binaryPath || "").trim();
  const downloadUrl = String(adapter.config.downloadUrl || "").trim();

  if (!targetPath || !downloadUrl) {
    throw new Error("binaryPath and downloadUrl must be configured for install");
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await downloadFile(downloadUrl, targetPath);
  await fsp.chmod(targetPath, 0o755);

  const msg = `go2rtc binary installed at ${targetPath}`;
  adapter.log.info(msg);
  await setStatus("stopped", Boolean(child), msg);
}

function downloadFile(url, targetPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(downloadFile(nextUrl, targetPath, redirects + 1));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const tempPath = `${targetPath}.download`;
      const out = fs.createWriteStream(tempPath, { mode: 0o755 });

      res.pipe(out);

      out.on("finish", async () => {
        out.close();
        try {
          await fsp.rename(tempPath, targetPath);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      out.on("error", async (error) => {
        try {
          await fsp.unlink(tempPath);
        } catch {
          // ignore cleanup error
        }
        reject(error);
      });
    });

    req.on("error", reject);
  });
}

async function setStatus(mode, running, message) {
  await adapter.setStateAsync("status.mode", mode, true);
  await adapter.setStateAsync("status.running", running, true);
  await adapter.setStateAsync("status.message", message || "", true);
}

async function ensureObjects() {
  const objects = [
    ["control", { type: "channel", common: { name: "Controls" }, native: {} }],
    ["control.start", boolState("Start go2rtc", true)],
    ["control.stop", boolState("Stop go2rtc", true)],
    ["control.restart", boolState("Restart go2rtc", true)],
    ["control.install", boolState("Install/Download binary", true)],
    ["status", { type: "channel", common: { name: "Status" }, native: {} }],
    ["status.running", boolState("go2rtc running", false, true)],
    ["status.mode", strState("Mode", false, true)],
    ["status.message", strState("Status message", false, true)],
    ["status.lastLog", strState("Last go2rtc log line", false, true)],
    ["status.lastError", strState("Last go2rtc error line", false, true)],
    ["status.pid", numState("Process ID", false, true)],
  ];

  for (const [id, obj] of objects) {
    await adapter.setObjectNotExistsAsync(id, obj);
  }
}

function boolState(name, write, read = true) {
  return {
    type: "state",
    common: { name, type: "boolean", role: "button", read, write, def: false },
    native: {},
  };
}

function strState(name, write, read = true) {
  return {
    type: "state",
    common: { name, type: "string", role: "text", read, write, def: "" },
    native: {},
  };
}

function numState(name, write, read = true) {
  return {
    type: "state",
    common: { name, type: "number", role: "value", read, write, def: 0 },
    native: {},
  };
}
