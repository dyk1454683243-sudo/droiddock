import { createHash } from "node:crypto";

export const VIDEO_QUALITY_TYPE_ERROR = "videoQuality must be a string. Allowed values: default, saver.";
export const VIDEO_QUALITY_NAME_ERROR = "Unknown videoQuality. Allowed values: default, saver.";

export const VIDEO_QUALITY_PRESETS = Object.freeze({
  default: Object.freeze({ maxSize: 1280, maxFps: 60, videoBitRate: 6_000_000 }),
  saver: Object.freeze({ maxSize: 800, maxFps: 30, videoBitRate: 2_000_000 }),
});

export type VideoQualityName = keyof typeof VIDEO_QUALITY_PRESETS;
export type VideoSettings = { name: VideoQualityName; maxSize: number; maxFps: number; videoBitRate: number };

export function resolveVideoQuality(value: unknown): VideoSettings {
  if (value === undefined) return { name: "default", ...VIDEO_QUALITY_PRESETS.default };
  if (typeof value !== "string") throw new Error(VIDEO_QUALITY_TYPE_ERROR);
  if (value !== "default" && value !== "saver") throw new Error(VIDEO_QUALITY_NAME_ERROR);
  const preset = VIDEO_QUALITY_PRESETS[value];
  return { name: value, maxSize: preset.maxSize, maxFps: preset.maxFps, videoBitRate: preset.videoBitRate };
}

export function sourceHasField(source: object | null | undefined, key: string): boolean {
  return source != null && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, key);
}

export function resolveVideoQualityFromSources(env: object = {}, local: object = {}): VideoSettings {
  if (sourceHasField(env, "DROIDDOCK_VIDEO_QUALITY")) return resolveVideoQuality((env as Record<string, unknown>).DROIDDOCK_VIDEO_QUALITY);
  if (sourceHasField(local, "videoQuality")) return resolveVideoQuality((local as Record<string, unknown>).videoQuality);
  return resolveVideoQuality(undefined);
}

export function configurationFingerprint(input: {
  deviceSerial: unknown;
  adb: unknown;
  deviceName: unknown;
  port: unknown;
  maxSize: number;
  maxFps: number;
  videoBitRate: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    input.deviceSerial, input.adb, input.deviceName, input.port, input.maxSize, input.maxFps, input.videoBitRate,
  ])).digest("hex").slice(0, 16);
}

export function configurationFingerprintFromConfig(config: {
  deviceSerial?: unknown;
  adb?: unknown;
  deviceName?: unknown;
  port?: unknown;
  video?: Pick<VideoSettings, "maxSize" | "maxFps" | "videoBitRate">;
}): string {
  const video = config.video ?? resolveVideoQuality(undefined);
  return configurationFingerprint({
    deviceSerial: config.deviceSerial,
    adb: config.adb,
    deviceName: config.deviceName,
    port: config.port,
    maxSize: video.maxSize,
    maxFps: video.maxFps,
    videoBitRate: video.videoBitRate,
  });
}

export function legacyConfigurationFingerprint(input: {
  deviceSerial: unknown;
  adb: unknown;
  deviceName: unknown;
  port: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify([
    input.deviceSerial, input.adb, input.deviceName, input.port,
  ])).digest("hex").slice(0, 16);
}

export function scrcpyVideoArgs(video: Pick<VideoSettings, "maxSize" | "maxFps" | "videoBitRate">): string[] {
  return [`max_size=${video.maxSize}`, `max_fps=${video.maxFps}`, `video_bit_rate=${video.videoBitRate}`];
}
