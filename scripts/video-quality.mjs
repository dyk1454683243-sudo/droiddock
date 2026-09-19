import { createHash } from 'node:crypto';

export const VIDEO_QUALITY_TYPE_ERROR = 'videoQuality must be a string. Allowed values: default, saver.';
export const VIDEO_QUALITY_NAME_ERROR = 'Unknown videoQuality. Allowed values: default, saver.';

export const VIDEO_QUALITY_PRESETS = Object.freeze({
  default: Object.freeze({ maxSize: 1280, maxFps: 60, videoBitRate: 6_000_000 }),
  saver: Object.freeze({ maxSize: 800, maxFps: 30, videoBitRate: 2_000_000 }),
});

export function resolveVideoQuality(value) {
  if (value === undefined) return { name: 'default', ...VIDEO_QUALITY_PRESETS.default };
  if (typeof value !== 'string') throw new Error(VIDEO_QUALITY_TYPE_ERROR);
  const preset = VIDEO_QUALITY_PRESETS[value];
  if (!preset) throw new Error(VIDEO_QUALITY_NAME_ERROR);
  return { name: value, maxSize: preset.maxSize, maxFps: preset.maxFps, videoBitRate: preset.videoBitRate };
}

export function sourceHasField(source, key) {
  return source != null && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, key);
}

export function resolveVideoQualityFromSources(env = {}, local = {}) {
  if (sourceHasField(env, 'DROIDDOCK_VIDEO_QUALITY')) return resolveVideoQuality(env.DROIDDOCK_VIDEO_QUALITY);
  if (sourceHasField(local, 'videoQuality')) return resolveVideoQuality(local.videoQuality);
  return resolveVideoQuality(undefined);
}

export function configurationFingerprint({ deviceSerial, adb, deviceName, port, maxSize, maxFps, videoBitRate }) {
  return createHash('sha256').update(JSON.stringify([deviceSerial, adb, deviceName, port, maxSize, maxFps, videoBitRate])).digest('hex').slice(0, 16);
}

export function configurationFingerprintFromConfig(config) {
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

export function legacyConfigurationFingerprint({ deviceSerial, adb, deviceName, port }) {
  return createHash('sha256').update(JSON.stringify([deviceSerial, adb, deviceName, port])).digest('hex').slice(0, 16);
}

export function scrcpyVideoArgs({ maxSize, maxFps, videoBitRate }) {
  return [`max_size=${maxSize}`, `max_fps=${maxFps}`, `video_bit_rate=${videoBitRate}`];
}
