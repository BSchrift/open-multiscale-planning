// The second test user (lib/stack.ts): a user in the environment's pool that the integration suite signs in as beside
// the first, to prove one user can't read another's records, with its password in SSM where the suite reads it. It's a
// custom resource, so each environment's deploy through the pipeline makes it, and nobody makes it by hand. The password
// is made here, never in the template, and goes only to Cognito and SSM: nothing logs it, and nothing returns it.
// Plain JavaScript, as Lambda's Node.js runs it, with the runtime's own AWS SDK.

import { randomBytes } from 'node:crypto';

// Cognito's default password policy wants a lowercase letter, an uppercase one, a digit and a symbol.
const newPassword = () => `${randomBytes(16).toString('hex')}Aa1-`;

/** What `call` returns, or undefined when AWS answers with the error named `missing`. */
async function unless(missing, call) {
  try {
    return await call();
  } catch (error) {
    if (error.name === missing) return undefined;
    throw error;
  }
}

/**
 * The handler for CDK's custom resource provider, given the Cognito and SSM clients it works with. Each step is safe to
 * run again, so a deploy that stopped part way finishes on the next one:
 *   - the password is stored before the user is made, so a user with no stored password was made by someone else, and is
 *     left alone;
 *   - a user is made, or its password set, only while it isn't confirmed.
 */
export const testUser = ({ cognito, ssm }) => async (event) => {
  const { UserPoolId, Username, Parameter } = event.ResourceProperties;
  // A user that's renamed or no longer wanted is kept, as the pool is, and so is the password the suite read.
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId };

  let password = (await unless('ParameterNotFound', () => ssm.getParameter({ Name: Parameter, WithDecryption: true })))?.Parameter.Value;
  const user = await unless('UserNotFoundException', () => cognito.adminGetUser({ UserPoolId, Username }));
  if (user && password === undefined) {
    throw new Error(`${Username} is already a user in this pool, and ${Parameter} doesn't hold its password. Name another user in integration.secondTestUser.`);
  }
  if (password === undefined) {
    password = newPassword();
    await ssm.putParameter({ Name: Parameter, Value: password, Type: 'SecureString', Overwrite: false });
  }
  if (!user) {
    // No email goes to it.
    await cognito.adminCreateUser({
      UserPoolId,
      Username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'email', Value: Username }, { Name: 'email_verified', Value: 'true' }],
    });
  }
  if (user?.UserStatus !== 'CONFIRMED') await cognito.adminSetUserPassword({ UserPoolId, Username, Password: password, Permanent: true });
  return { PhysicalResourceId: Username };
};

let clients;
export const handler = async (event) => {
  // Loaded on first use, so the tests, which pass their own clients, need no SDK.
  clients ??= {
    cognito: new (await import('@aws-sdk/client-cognito-identity-provider')).CognitoIdentityProvider(),
    ssm: new (await import('@aws-sdk/client-ssm')).SSM(),
  };
  return testUser(clients)(event);
};
