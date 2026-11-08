// Generated from protocol.yaml by go generate in config/, after Go checked it. Edit that, not this: see
// docs/config.md.

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
  }
} as const;
