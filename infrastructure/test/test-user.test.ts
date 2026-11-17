import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { testUser } from '../test-user/index.mjs';

const UserPoolId = 'us-west-2_pool';
const Username = 'second-test@example.net';
const Parameter = '/multiscale/staging/second-test-user-password';
const event = (RequestType: string, PhysicalResourceId?: string) => ({ RequestType, PhysicalResourceId, ResourceProperties: { ServiceToken: 'arn', UserPoolId, Username, Parameter } });

/**
 * Cognito and SSM as they stand: the user's status if it exists, and the stored password if there is one. Each call is
 * recorded by name, in order.
 */
function aws({ status, stored }: { status?: string; stored?: string } = {}) {
  const calls: [string, any][] = [];
  const named = (name: string) => Object.assign(new Error(name), { name });
  const call = (name: string, run: (input: any) => unknown) => async (input: any) => {
    calls.push([name, input]);
    return run(input);
  };
  const cognito = {
    adminGetUser: call('adminGetUser', () => {
      if (!status) throw named('UserNotFoundException');
      return { Username: 'a-sub', UserStatus: status };
    }),
    adminCreateUser: call('adminCreateUser', () => ({})),
    adminSetUserPassword: call('adminSetUserPassword', () => ({})),
  };
  const ssm = {
    getParameter: call('getParameter', () => {
      if (stored === undefined) throw named('ParameterNotFound');
      return { Parameter: { Value: stored } };
    }),
    putParameter: call('putParameter', () => ({})),
  };
  const writes = () => calls.filter(([name]) => !/^(adminGetUser|getParameter)$/.test(name));
  return { calls, writes, handle: testUser({ cognito, ssm }) };
}

describe('the second test user', () => {
  it('stores a new password first, then makes the user with it, verified and sent nothing', async (t) => {
    const log = t.mock.method(console, 'log');
    const error = t.mock.method(console, 'error');
    const { writes, calls, handle } = aws();
    const result = await handle(event('Create'));

    const [put, create, set] = writes();
    assert.deepEqual(writes().map(([name]) => name), ['putParameter', 'adminCreateUser', 'adminSetUserPassword']);
    const password = put![1].Value as string;
    // Cognito's default policy wants a lowercase letter, an uppercase one, a digit and a symbol.
    assert.match(password, /^[0-9a-f]{32}Aa1-$/);
    assert.deepEqual(put![1], { Name: Parameter, Value: password, Type: 'SecureString', Overwrite: false });
    assert.deepEqual(create![1], {
      UserPoolId,
      Username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'email', Value: Username }, { Name: 'email_verified', Value: 'true' }],
    });
    assert.deepEqual(set![1], { UserPoolId, Username, Password: password, Permanent: true });
    assert.deepEqual(calls.find(([name]) => name === 'getParameter')![1], { Name: Parameter, WithDecryption: true });

    // The provider logs what the handler returns, and the password goes nowhere but Cognito and SSM.
    assert.deepEqual(result, { PhysicalResourceId: Username });
    const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls].map((c) => c.arguments));
    assert.ok(!logged.includes(password));
  });

  it('makes each password anew', async () => {
    const one = aws();
    const two = aws();
    await one.handle(event('Create'));
    await two.handle(event('Create'));
    assert.notEqual(one.writes()[0]![1].Value, two.writes()[0]![1].Value);
  });

  it('changes nothing once the user and its password are there, as after a first deploy or the setup guide by hand', async () => {
    for (const type of ['Create', 'Update']) {
      const { writes, handle } = aws({ status: 'CONFIRMED', stored: 'pw' });
      assert.deepEqual(await handle(event(type, Username)), { PhysicalResourceId: Username });
      assert.deepEqual(writes(), []);
    }
  });

  it('finishes a deploy that stopped part way, with the password already stored', async () => {
    const noUser = aws({ stored: 'pw' });
    await noUser.handle(event('Create'));
    assert.deepEqual(noUser.writes().map(([name, input]) => [name, input.Password]), [['adminCreateUser', undefined], ['adminSetUserPassword', 'pw']]);

    const noPassword = aws({ status: 'FORCE_CHANGE_PASSWORD', stored: 'pw' });
    await noPassword.handle(event('Create'));
    assert.deepEqual(noPassword.writes().map(([name, input]) => [name, input.Password]), [['adminSetUserPassword', 'pw']]);
  });

  it("refuses a user it didn't make, whose password isn't stored, and writes nothing", async () => {
    const { writes, handle } = aws({ status: 'CONFIRMED' });
    await assert.rejects(handle(event('Create')), (e: Error) => e.message.includes(Username) && e.message.includes(Parameter) && e.message.includes('integration.secondTestUser'));
    assert.deepEqual(writes(), []);
  });

  it('fails the deploy on any other error from AWS, writing nothing', async () => {
    const denied = Object.assign(new Error('not allowed'), { name: 'AccessDeniedException' });
    const put = mock.fn(async () => ({}));
    const failing = testUser({
      cognito: { adminGetUser: async () => Promise.reject(denied) },
      ssm: { getParameter: async () => Promise.reject(Object.assign(new Error('none'), { name: 'ParameterNotFound' })), putParameter: put },
    });
    await assert.rejects(failing(event('Create')), /not allowed/);
    assert.equal(put.mock.callCount(), 0);
  });

  it('keeps the user and its password when the resource goes, as the pool is kept', async () => {
    const { calls, handle } = aws({ status: 'CONFIRMED', stored: 'pw' });
    assert.deepEqual(await handle(event('Delete', Username)), { PhysicalResourceId: Username });
    assert.deepEqual(calls, []);
  });
});
