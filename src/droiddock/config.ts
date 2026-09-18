import { readFileSync } from "node:fs";

interface LocalConfig { deviceSerial?: string; deviceName?: string; adb?: string; port?: number; }
let local: LocalConfig = {};
try {
  local = JSON.parse(readFileSync(new URL("../../config.local.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));
  if (!local || typeof local !== "object" || Array.isArray(local)) throw new Error("Expected a JSON object.");
  for (const field of ["deviceSerial", "deviceName", "adb"] as const) {
    if (local[field] !== undefined && typeof local[field] !== "string") throw new Error(`${field} must be a string.`);
  }
} catch (error) {
  // Parser causes may echo configuration contents. Keep them out of startup logs.
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid config.local.json. Check the local configuration format.");
}

export const config = {
  deviceSerial: process.env.DROIDDOCK_DEVICE_SERIAL ?? local.deviceSerial ?? "",
  deviceName: process.env.DROIDDOCK_DEVICE_NAME ?? local.deviceName ?? "Android phone",
  adb: process.env.DROIDDOCK_ADB ?? local.adb ?? "adb",
  port: Number(process.env.DROIDDOCK_PORT ?? local.port ?? 3210),
};
