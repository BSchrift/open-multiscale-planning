// The parts of scripts/files-key.sh that need Node: making the key pair CloudFront checks download links against, and
// adding its public half to <env>.yaml, comments and all.
// Usage: node bin/files-key.ts check <env> <name>      refuses a bad name, or one <env>.yaml already has
//        node bin/files-key.ts generate <dir>          writes private.pem (PKCS#8) and public.pem (SPKI) there
//        node bin/files-key.ts add <env> <name> <pem>  adds the public key, and signs with it if it's the first

import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { Scalar, YAMLMap } from 'yaml';
import { configDir } from '../lib/config.ts';

const [command, ...args] = process.argv.slice(2);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const fileOf = (envName: string) => join(configDir(), `${envName}.yaml`);
const read = (envName: string) => parseDocument(readFileSync(fileOf(envName), 'utf8'));

if (command === 'check') {
  const [envName, name] = args as [string, string];
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail(`NAME ${JSON.stringify(name)} must be 1 to 64 letters, digits, - and _`);
  if (read(envName).hasIn(['files', 'keys', name])) fail(`${fileOf(envName)} already has a files key named ${name}. Pick another NAME.`);
} else if (command === 'generate') {
  // CloudFront takes only RSA 2048 keys for signed URLs.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(join(args[0]!, 'private.pem'), privateKey, { mode: 0o600 });
  writeFileSync(join(args[0]!, 'public.pem'), publicKey, { mode: 0o600 });
} else if (command === 'add') {
  const [envName, name, pemFile] = args as [string, string, string];
  const doc = read(envName);
  const signWith = doc.getIn(['files', 'signWith']) as string | undefined;
  if (!doc.has('files')) {
    const files = doc.createPair('files', { keys: {}, signWith: name });
    const key = files.key as Scalar;
    key.spaceBefore = true;
    key.commentBefore =
      ` Attachments: the public keys CloudFront checks download links against, written by make files-key. Each one's\n` +
      ` private key is the SSM SecureString /multiscale/${envName}/files/<name>, and signWith is the one the API signs with.`;
    (doc.contents as YAMLMap).add(files);
  }
  doc.setIn(['files', 'keys', name], readFileSync(pemFile, 'utf8'));
  writeFileSync(fileOf(envName), doc.toString());
  console.log(`Added the public key ${name} to ${fileOf(envName)}.`);
  if (!signWith) {
    // The pipeline's copy first: a release from a copy without files would take the files host away again.
    console.log(`Next: make pipeline-config if the release pipeline is set up, so it deploys the new ${envName}.yaml, then make deploy ENV=${envName}.`);
    console.log('Attachments are on once that deploy finishes. Commit the config folder.');
  } else {
    console.log(`The API still signs with ${signWith}. To finish moving to ${name}:`);
    console.log(`  1. make pipeline-config if the release pipeline is set up, then make deploy ENV=${envName}: CloudFront now trusts both keys.`);
    console.log(`  2. Set files.signWith to ${name} in ${fileOf(envName)}, make pipeline-config, then deploy again: the API signs with ${name}.`);
    console.log(`  3. Once that deploy has finished, canary included, wait 5 minutes for the last link signed with ${signWith} to expire.`);
    console.log(`     Then delete files.keys.${signWith}, make pipeline-config, deploy, and delete its private key:`);
    console.log(`     aws ssm delete-parameter --name /multiscale/${envName}/files/${signWith}`);
  }
} else {
  fail('Use: node bin/files-key.ts check <env> <name> | generate <dir> | add <env> <name> <pem>');
}
