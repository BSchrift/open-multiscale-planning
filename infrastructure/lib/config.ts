import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type EnvName = 'staging' | 'prod';

// Only what the stacks and scripts use. The backend's loader checks every key.
export interface Aws {
  account: string;
  region: string;
  profile: string;
}

export interface ControlConfig {
  aws: Aws;
  /** hostedZoneId is the zone Route 53 made when the domain was registered. txt is the domain's own TXT values, such as a site verification. */
  dns?: { domain: string; hostedZoneId: string; txt?: string[] };
  /** The release pipeline, which runs in this account: the GitHub repository and branch it releases, and who it emails. */
  pipeline?: PipelineConfig;
}

export interface PipelineConfig {
  repository: string;
  branch: string;
  email: string;
  /** How long after staging passes a run goes to prod, as an ISO 8601 duration: PT2H unless set, PT0S for no wait. */
  promoteAfter?: string;
}

/** The window before prod when control.yaml doesn't set one: time to read the email and stop the run, the same day. */
export const DEFAULT_PROMOTE_AFTER = 'PT2H';
// The pipeline waits on Step Functions, which CodePipeline allows 7 days, and prod's canary takes another.
const MAX_PROMOTE_AFTER_SECONDS = 6 * 24 * 3600;

/** A window in seconds: whole days, hours, minutes and seconds, such as PT2H, P1DT30M or PT0S. Undefined if it isn't one. */
export function promoteAfterSeconds(text: unknown): number | undefined {
  const m = typeof text === 'string' ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text) : null;
  if (!m || text === 'P' || (text as string).endsWith('T')) return undefined;
  const [days, hours, minutes, seconds] = m.slice(1).map((part) => Number(part ?? 0));
  const total = ((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!;
  return total <= MAX_PROMOTE_AFTER_SECONDS ? total : undefined;
}

export interface Config {
  aws: Aws;
  alarmEmail: string;
  auth: { cognitoDomainPrefix: string; signInCallbackUrls: string[] };
  dns?: { zone: string };
  /**
   * Attachments' storage, written by make files-key. keys names each public key CloudFront checks download links
   * against, an RSA 2048 PEM whose private half is the SSM SecureString /multiscale/<env>/files/<name>; signWith is the
   * one the API signs with. Without it the environment has no attachments.
   */
  files?: { keys: Record<string, string>; signWith: string };
}

// Holds the committed examples, and is the config folder unless MULTISCALE_CONFIG_DIR names another.
const exampleDir = join(import.meta.dirname, '../../config');
export const configDir = () => process.env.MULTISCALE_CONFIG_DIR || exampleDir;

const EXAMPLE_ACCOUNTS = ['111111111111', '222222222222', '333333333333'];
const domainName = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const matches = (re: RegExp, value: unknown) => typeof value === 'string' && re.test(value);

function checkCallback(url: unknown): boolean {
  // Cognito rejects plain http except on localhost.
  return matches(/^(https:\/\/|http:\/\/localhost[:/]|(?!https?:)[a-z][a-z0-9+.-]*:\/\/)/, url);
}

/** Without `deploying`, a missing file falls back to its committed example so that a fresh clone and CI can synthesize. */
function locate(dir: string, name: string, deploying: boolean): string {
  const real = join(dir, `${name}.yaml`);
  const example = join(exampleDir, `${name}.example.yaml`);
  if (existsSync(real)) return real;
  if (deploying) throw new Error(`Missing ${real}. Copy ${example} there and fill it in.`);
  return example;
}

function read(path: string): any {
  return parse(readFileSync(path, 'utf8')) ?? {};
}

function awsProblems(aws: any): string[] {
  const problems: string[] = [];
  // Unquoted, YAML reads it as a number and drops any leading zero.
  if (!matches(/^\d{12}$/, aws?.account)) problems.push('aws.account must be 12 digits in quotes');
  if (!matches(/^[a-z]{2}(-[a-z]+)+-\d$/, aws?.region)) problems.push('aws.region must be like us-west-2');
  if (!matches(/^[\w.@+-]+$/, aws?.profile)) problems.push('aws.profile must name an AWS CLI profile');
  return problems;
}

// CloudFront takes only RSA 2048 public keys for signed URLs.
function filesProblems(files: any): string[] {
  const keys = files?.keys;
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length === 0) {
    return ['files.keys must name at least one public key, as make files-key writes it'];
  }
  const problems: string[] = [];
  for (const [name, pem] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      problems.push(`files.keys has a key named ${JSON.stringify(name)}: use letters, digits, - and _`);
      continue;
    }
    let bits: number | undefined;
    try {
      const key = createPublicKey(String(pem));
      if (key.asymmetricKeyType === 'rsa') bits = key.asymmetricKeyDetails?.modulusLength;
    } catch {
      // Reported below.
    }
    if (bits !== 2048) problems.push(`files.keys.${name} must be an RSA 2048 public key in PEM`);
  }
  if (typeof files.signWith !== 'string' || !Object.hasOwn(keys, files.signWith)) problems.push('files.signWith must name one of files.keys');
  return problems;
}

function done<T>(path: string, problems: string[], value: T): T {
  if (problems.length > 0) throw new Error(`${path}: ${problems.join('; ')}`);
  return value;
}

function controlAt(path: string, deploying: boolean): ControlConfig {
  const c = read(path);
  const problems = awsProblems(c.aws);
  if (c.dns != null && !matches(domainName, c.dns.domain)) problems.push('dns.domain must be a lowercase domain name like example.net');
  if (c.dns != null && !matches(/^Z[0-9A-Z]{1,32}$/, c.dns.hostedZoneId)) problems.push('dns.hostedZoneId must be a Route 53 zone id like Z0123456789ABCDEFGHIJ');
  if (c.dns?.txt != null && !(Array.isArray(c.dns.txt) && c.dns.txt.every((v: unknown) => typeof v === 'string' && v !== ''))) {
    problems.push('dns.txt must be a list of TXT values');
  }
  if (c.pipeline != null) {
    if (!matches(/^[\w.-]+\/[\w.-]+$/, c.pipeline.repository)) problems.push('pipeline.repository must be a GitHub owner/name');
    if (!matches(/^[\w.\/-]+$/, c.pipeline.branch)) problems.push('pipeline.branch must be a branch name');
    if (!matches(email, c.pipeline.email)) problems.push('pipeline.email must be an email address');
    c.pipeline.promoteAfter ??= DEFAULT_PROMOTE_AFTER;
    if (promoteAfterSeconds(c.pipeline.promoteAfter) === undefined) {
      problems.push('pipeline.promoteAfter must be whole days, hours, minutes or seconds up to 6 days, such as PT2H, or PT0S for no wait');
    }
  }
  if (deploying && (EXAMPLE_ACCOUNTS.includes(c.aws?.account) || matches(/(^|\.)example\.com$/, c.dns?.domain) || matches(/@example\.com$/i, c.pipeline?.email))) {
    problems.push('still has example values');
  }
  return done(path, problems, c);
}

export const loadControl = (dir: string, deploying: boolean) => controlAt(locate(dir, 'control', deploying), deploying);

/** Also loads control.yaml when the environment sets dns.zone, since the zone is delegated from its domain. */
export function loadConfig(envName: EnvName, dir: string, deploying: boolean): { config: Config; control?: ControlConfig } {
  const path = locate(dir, envName, deploying);
  const c = read(path);
  const problems = awsProblems(c.aws);
  if (!matches(email, c.alarmEmail)) problems.push('alarmEmail must be an email address');
  const { cognitoDomainPrefix, signInCallbackUrls } = c.auth ?? {};
  // Cognito reserves these words in hosted UI prefixes.
  if (!matches(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, cognitoDomainPrefix) || /aws|amazon|cognito/.test(cognitoDomainPrefix)) {
    problems.push('auth.cognitoDomainPrefix must be lowercase letters, digits and hyphens, without aws, amazon or cognito');
  }
  if (!Array.isArray(signInCallbackUrls) || signInCallbackUrls.length === 0 || !signInCallbackUrls.every(checkCallback)) {
    problems.push('auth.signInCallbackUrls must list https, custom scheme or localhost URLs');
  }
  if (c.files != null) problems.push(...filesProblems(c.files));

  let control: ControlConfig | undefined;
  const zone = c.dns?.zone;
  if (zone !== undefined) {
    // An example pairs with the example control, so that synth works before every file is filled in.
    const fromExample = path === join(exampleDir, `${envName}.example.yaml`);
    control = controlAt(fromExample ? join(exampleDir, 'control.example.yaml') : locate(dir, 'control', true), deploying);
    const domain = control.dns?.domain;
    if (!domain || !matches(domainName, zone) || !zone.endsWith(`.${domain}`)) {
      problems.push("dns.zone must be a lowercase subdomain of control.yaml's dns.domain");
    }
    // Both would delegate the same name from the parent zone, and each deploy would undelegate the other's zone.
    const other = join(dir, `${envName === 'staging' ? 'prod' : 'staging'}.yaml`);
    if (existsSync(other) && read(other).dns?.zone === zone) problems.push(`dns.zone is already ${other}'s`);
  }
  if (deploying && (EXAMPLE_ACCOUNTS.includes(c.aws?.account) || matches(/change-me$/, cognitoDomainPrefix) || matches(/@example\.com$/i, c.alarmEmail))) {
    problems.push('still has example values');
  }
  return done(path, problems, { config: c, control });
}
