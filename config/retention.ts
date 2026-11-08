// The TypeScript reader of retention.yaml, for the app's build and the deploy. retention.go is the other, for the
// Lambdas, and the two check the same rules. It imports nothing, so the frontend and the infrastructure can each load it
// with their own YAML parser, passed in.

export type RetentionEnv = 'prod' | 'staging' | 'local';

/** An ISO 8601 duration in parts. Years, months and days are calendar steps in UTC. Weeks are counted as days. */
export interface Period {
  iso: string;
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** One environment's block of retention.yaml. */
export interface Retention {
  scheduling: Period;
  closed: Period;
  deleted: Period;
  /** How often staging's cleanup job runs. Absent where DynamoDB's TTL alone removes what has expired. */
  cleanup?: Period;
}

const ENVS: readonly RetentionEnv[] = ['prod', 'staging', 'local'];
const PERIODS = ['scheduling', 'closed', 'deleted'] as const;
const PERIOD = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Reads an ISO 8601 duration of whole numbers, such as P2Y or PT10M. Throws unless it's longer than zero. */
export function parsePeriod(text: unknown): Period {
  const m = typeof text === 'string' && text !== 'P' && !text.endsWith('T') ? PERIOD.exec(text) : null;
  if (!m) throw new Error(`${JSON.stringify(text)} is not an ISO 8601 duration such as P30D or PT10M`);
  const n = m.map((part) => (part === undefined ? 0 : Number(part)));
  if (n.some((value) => value > 100000)) throw new Error(`${text} has a number out of range`);
  const [, years = 0, months = 0, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0] = n;
  const period = { iso: text as string, years, months, days: weeks * 7 + days, hours, minutes, seconds };
  if (!years && !months && !period.days && !hours && !minutes && !seconds) throw new Error(`${text} is zero`);
  return period;
}

function parseBlock(block: unknown): Retention {
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('must be a mapping');
  const extra = Object.keys(block).find((key) => key !== 'cleanup' && !(PERIODS as readonly string[]).includes(key));
  if (extra) throw new Error(`unknown key ${extra}`);
  const values = block as Record<string, unknown>;
  const read = (key: (typeof PERIODS)[number]) => {
    if (values[key] === undefined) throw new Error(`${key} is required`);
    try {
      return parsePeriod(values[key]);
    } catch (error) {
      throw new Error(`${key}: ${(error as Error).message}`);
    }
  };
  const retention: Retention = { scheduling: read('scheduling'), closed: read('closed'), deleted: read('deleted') };
  if (values.cleanup === undefined) return retention;
  // EventBridge Scheduler runs a rate in whole minutes, hours or days.
  const wrong = new Error('cleanup must be whole minutes, hours or days, such as PT1M or P1D');
  let cleanup: Period;
  try {
    cleanup = parsePeriod(values.cleanup);
  } catch {
    throw wrong;
  }
  if (cleanup.years || cleanup.months || cleanup.seconds) throw wrong;
  return { ...retention, cleanup };
}

/**
 * One environment's block. Every block is checked each time, so a bad value anywhere fails the first reader. read and
 * parse are the caller's file reader and YAML parser.
 */
export function loadRetention(env: string, io: { read(path: string): string; parse(text: string): unknown }): Retention {
  const file = `${import.meta.dirname}/retention.yaml`;
  const doc = io.parse(io.read(file));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} must be a mapping of environments`);
  const extra = Object.keys(doc).find((key) => !(ENVS as readonly string[]).includes(key));
  if (extra) throw new Error(`${file}: unknown environment ${extra}`);
  let picked: Retention | undefined;
  for (const name of ENVS) {
    try {
      const block = parseBlock((doc as Record<string, unknown>)[name]);
      if (name === env) picked = block;
    } catch (error) {
      throw new Error(`${file}: ${name}: ${(error as Error).message}`);
    }
  }
  if (!picked) throw new Error(`${file} has prod, staging and local, not ${env}`);
  return picked;
}
