// Generated from protocol.yaml and env/*.yaml by go generate in config/, after Go checked them. Edit those, not
// this: see docs/config.md.

export const protocol = {
  "sync": {
    "maxChanges": 99,
    "maxRecordBytes": 102400,
    "mergedRoomBytes": 1024,
    "clientBatchBytes": 4194304,
    "maxBodyBytes": 5242880,
    "maxClockAheadHours": 24
  },
  "records": {
    "idPattern": "^[\\x21-\\x7e]{1,200}$"
  },
  "clock": {
    "pattern": "^(\\d{13})-(\\d{6})-([\\x21-\\x7e]+)$",
    "maxCounter": 999999
  },
  "telemetry": {
    "maxBatchEvents": 200
  },
  "attachments": {
    "maxFileBytes": 10485760,
    "maxPerTask": 10,
    "maxIdsPerDownload": 20,
    "contentTypes": [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/heic",
      "application/pdf",
      "text/plain",
      "text/csv",
      "text/markdown",
      "application/rtf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation"
    ]
  }
} as const;

export const envs = {
  "local": {
    "stack": {
      "terminationProtection": false,
      "canaryPercent": 5,
      "canaryMinutes": 10,
      "throttleReleaseAlarm": false
    },
    "attachments": {
      "defaultQuotaBytes": 20971520,
      "uploadsPerHour": 60,
      "downloadBytesPerHour": 1073741824
    }
  },
  "staging": {
    "stack": {
      "terminationProtection": false,
      "canaryPercent": 5,
      "canaryMinutes": 10,
      "throttleReleaseAlarm": false
    },
    "attachments": {
      "defaultQuotaBytes": 20971520,
      "uploadsPerHour": 60,
      "downloadBytesPerHour": 1073741824
    }
  },
  "prod": {
    "stack": {
      "terminationProtection": true,
      "canaryPercent": 5,
      "canaryMinutes": 1440,
      "throttleReleaseAlarm": true
    },
    "attachments": {
      "defaultQuotaBytes": 1073741824,
      "uploadsPerHour": 60,
      "downloadBytesPerHour": 1073741824
    }
  },
} as const;

export type EnvName = keyof typeof envs;
export type EnvConfig = (typeof envs)[EnvName];

/** An environment's settings, by its name. Throws on any other name, so a build can't go ahead with none. */
export function forEnv(env: string): EnvConfig {
  if (!Object.hasOwn(envs, env)) throw new Error(`No environment ${JSON.stringify(env)} in config/env: use local, staging or prod.`);
  return envs[env as EnvName];
}
