import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const read = (path) => {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};

const bytes = (n) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};

const duration = (s) => {
  s = Math.floor(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
};

const detectContainer = () => {
  const cgroup = read("/proc/1/cgroup") ?? "";
  if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  if (fs.existsSync("/.dockerenv") || /docker/.test(cgroup)) return "docker";
  if (fs.existsSync("/run/.containerenv") || /podman|libpod/.test(cgroup)) return "podman";
  if (/lxc/.test(cgroup)) return "lxc";
  return "none detected";
};

const cgroupLimits = () => {
  const mem = read("/sys/fs/cgroup/memory.max") ?? read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const cpu = read("/sys/fs/cgroup/cpu.max");
  const memStr = !mem ? "n/a" : mem === "max" ? "unlimited" : bytes(Number(mem));
  let cpuStr = "n/a";
  if (cpu) {
    const [quota, period] = cpu.split(" ");
    cpuStr = quota === "max" ? "unlimited" : `${(Number(quota) / Number(period)).toFixed(2)} cores`;
  }
  return { memStr, cpuStr };
};

const disk = async () => {
  try {
    const { stdout } = await run("df", ["-h", "/"]);
    const row = stdout.trim().split("\n")[1]?.split(/\s+/);
    return row ? `${row[2]} used / ${row[1]} (${row[4]})` : "n/a";
  } catch {
    return "n/a";
  }
};

const networks = () =>
  Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) =>
      (addrs ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => `${name}: ${a.address}`),
    )
    .join(", ") || "none";

export async function gatherInfo() {
  const osRelease = read("/etc/os-release")?.match(/^PRETTY_NAME="?(.*?)"?$/m)?.[1];
  const cpus = os.cpus();
  const { memStr, cpuStr } = cgroupLimits();
  const used = os.totalmem() - os.freemem();
  const mem = process.memoryUsage();

  const rows = [
    ["OS", osRelease ?? `${os.type()} ${os.release()}`],
    ["Kernel", `${os.release()} (${os.arch()})`],
    ["Host", os.hostname()],
    ["Uptime", duration(os.uptime())],
    ["Container", detectContainer()],
    ["CPU", `${cpus[0]?.model ?? "unknown"} (${cpus.length} logical)`],
    ["Load avg", os.loadavg().map((n) => n.toFixed(2)).join(" ")],
    ["Memory", `${bytes(used)} / ${bytes(os.totalmem())}`],
    ["cgroup limits", `mem ${memStr}, cpu ${cpuStr}`],
    ["Disk (/)", await disk()],
    ["Network", networks()],
    ["Node", `${process.version} (v8 ${process.versions.v8})`],
    ["Bot PID", `${process.pid}`],
    ["Bot uptime", duration(process.uptime())],
    ["Bot memory", `${bytes(mem.rss)} rss, ${bytes(mem.heapUsed)} heap`],
  ];

  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}
