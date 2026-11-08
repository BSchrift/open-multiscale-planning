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
  }
} as const;
