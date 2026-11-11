// "Promote now", the link in the email before prod (lib/pipeline-stack.ts). It ends the run's window at once, by
// sending the task token in its query back to the state machine waiting on it. GET only shows the button, since mail
// scanners open links to check them; the button's POST is what promotes. The token is never logged.
// Plain JavaScript, as Lambda's Node.js runs it, with the runtime's own AWS SDK.

// The token was used already, or its window ended, which promoted the run, or the run was stopped.
const gone = new Set(['TaskTimedOut', 'TaskDoesNotExist']);

const page = (statusCode, title, text = '', form = '') => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body: `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body { font: 1rem/1.5 system-ui, sans-serif; margin: 2rem 1rem; max-width: 36rem } button { font: inherit; min-height: 44px; padding: 0 1.25rem }</style>
<h1>${title}</h1>
${text && `<p>${text}</p>`}
${form}
`,
});

/** The handler, given the Step Functions client it sends the token with. */
export const promoteNow = (sfn) => async (event) => {
  if (event.requestContext.http.method !== 'POST') {
    // No action, so the form posts back to this address, token and all; the page never echoes it.
    return page(200, 'Promote this release now', "It goes to prod now instead of when its window ends. Prod's canary and its alarms still guard it.",
      '<form method="post"><button type="submit">Promote now</button></form>');
  }
  const incomplete = () => page(400, 'Nothing to promote', 'This link is incomplete. Open it again from the email.');
  const taskToken = new URLSearchParams(event.rawQueryString).get('token');
  if (!taskToken) return incomplete();
  try {
    await sfn.sendTaskSuccess({ taskToken, output: '{}' });
  } catch (error) {
    if (gone.has(error.name)) return page(410, 'Nothing to promote', 'This run already went to prod or was stopped.');
    if (error.name === 'InvalidToken') return incomplete();
    console.error('SendTaskSuccess failed:', error.name);
    return page(502, "Couldn't promote", 'Try again in a moment. If it still fails, the run goes to prod when its window ends.');
  }
  return page(200, 'Promoted: prod starts now.');
};

let sfn;
export const handler = async (event) => {
  // Loaded on first use, so the tests, which pass their own client, need no SDK.
  sfn ??= new (await import('@aws-sdk/client-sfn')).SFN();
  return promoteNow(sfn)(event);
};
