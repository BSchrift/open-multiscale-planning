import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { promoteNow } from '../promote-now/index.mjs';

// A task token, as the email's link carries it: encoded, since a real one has characters such as + and /.
const token = 'AQB4AAAA+tok/en==';
const request = (method: string, rawQueryString = `token=${encodeURIComponent(token)}`) => ({ requestContext: { http: { method } }, rawQueryString });

/** A Step Functions client that records each SendTaskSuccess, and fails it with the named error when given one. */
function client(error?: string) {
  const sent: unknown[] = [];
  const sfn = {
    sendTaskSuccess: async (input: unknown) => {
      sent.push(input);
      if (error) throw Object.assign(new Error(`${error}: Provided task does not exist anymore`), { name: error });
      return {};
    },
  };
  return { sent, handle: promoteNow(sfn) };
}

describe('the Promote now link', () => {
  it('only shows a Promote now button on GET, promoting nothing, since mail scanners open links', async () => {
    for (const method of ['GET', 'HEAD']) {
      const { sent, handle } = client();
      const response = await handle(request(method));
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /<form method="post">/);
      assert.match(response.body, /<button[^>]*>Promote now<\/button>/);
      assert.deepEqual(sent, []);
    }
  });

  it('promotes on POST by sending back exactly the token in the link', async () => {
    const { sent, handle } = client();
    const response = await handle(request('POST'));
    assert.deepEqual(sent, [{ taskToken: token, output: '{}' }]);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Promoted: prod starts now\./);
  });

  it('says the run already went to prod or was stopped when its token is no longer valid', async () => {
    for (const error of ['TaskTimedOut', 'TaskDoesNotExist']) {
      const response = await client(error).handle(request('POST'));
      assert.equal(response.statusCode, 410);
      assert.match(response.body, /This run already went to prod or was stopped\./);
      assert.doesNotMatch(response.body, /Promoted/);
    }
  });

  it('says a link without a whole token is incomplete', async () => {
    const empty = client();
    assert.equal((await empty.handle(request('POST', ''))).statusCode, 400);
    assert.deepEqual(empty.sent, []);
    const cut = await client('InvalidToken').handle(request('POST', 'token=AQB4'));
    assert.equal(cut.statusCode, 400);
    assert.match(cut.body, /incomplete/);
  });

  it('never lets a response be cached, and never logs the token', async (t) => {
    const logged = [mock.method(console, 'log'), mock.method(console, 'error'), mock.method(console, 'warn'), mock.method(console, 'info')];
    t.after(() => mock.restoreAll());
    const responses = [
      await client().handle(request('GET')),
      await client().handle(request('POST')),
      await client('TaskTimedOut').handle(request('POST')),
      await client('InvalidToken').handle(request('POST')),
      await client().handle(request('POST', '')),
      await client('ThrottlingException').handle(request('POST')),
    ];
    for (const response of responses) assert.equal(response.headers['Cache-Control'], 'no-store');
    // Any other failure says to try again, as the window still promotes the run when it ends.
    assert.equal(responses[5]!.statusCode, 502);
    const output = logged.flatMap((m) => m.mock.calls.flatMap((call) => call.arguments.map(String))).join('\n');
    assert.ok(!output.includes(token) && !output.includes(encodeURIComponent(token)), output);
  });
});
