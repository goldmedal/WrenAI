import { expect, test } from '@playwright/test';

for (const ending of ['stop', 'failure'] as const) {
test(`direct conversation safely renders, prompts, cancels, reconnects and handles ${ending}`, async ({ page }) => {
  const id = 'native-session-00000000-0000-4000-8000-000000000001';
  const capability = '00000000-0000-4000-8000-000000000002';
  let status = 'running';
  const row = () => ({ id, transport: 'conversation', purpose: 'analysis', vendor: 'codex', agent: 'answer_query',
    scopeKind: 'bound_project', scopeId: 'scope', projectIdentity: 'project', bindingGeneration: 1, projectRevision: '1',
    createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', startedAt: '2026-09-29T00:00:00Z',
    status, endedAt: status === 'stopped' ? '2026-09-29T01:00:00Z' : null, exitCode: null, failure: null });
  await page.addInitScript(({ id, capability }) => sessionStorage.setItem(`wren-genbi-native-session-capability:${id}`, capability), { id, capability });
  await page.route('**/api/native-sessions', (route) => route.fulfill({ json: { sessions: [row()] } }));
  await page.route(`**/api/native-sessions/${id}`, (route) => route.fulfill({ json: { session: row() } }));
  await page.route(`**/api/native-sessions/${id}/stop`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ capability }); status = 'stopped'; await route.fulfill({ status: 204 });
  });
  let connection = 0;
  let closeSocket!: () => void;
  let failSocket!: () => void;
  const commands: unknown[] = [];
  await page.routeWebSocket(`**/api/native-sessions/${id}/conversation?*`, (ws) => {
    connection++;
    expect(new URL(ws.url()).searchParams.get('cap')).toBe(capability);
    let sequence = 1;
    const state = (value: string) => ws.send(JSON.stringify({ type: 'state', sequence: ++sequence, state: value }));
    ws.send(JSON.stringify({ type: 'replay', afterSequence: 0, throughSequence: 1, truncated: connection > 1, state: 'ready' }));
    ws.send(JSON.stringify({ type: 'state', sequence: 1, state: 'ready' }));
    failSocket = () => { status = 'failed'; state('failed'); };
    closeSocket = () => { status = 'detached'; ws.close(); };
    ws.onMessage((raw) => {
      const command = JSON.parse(String(raw)); commands.push(command);
      if (command.type === 'prompt') {
        state('running');
        ws.send(JSON.stringify({ type: 'event', sequence: ++sequence, event: { method: 'item/completed', params: {
          threadId: 'thread', turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: '<img src=x onerror=alert(1)> 99 orders' },
        } } }));
      }
      if (command.type === 'interrupt') state('ready');
    });
  });
  await page.goto(`/sessions/${id}`);
  await expect(page.getByRole('region', { name: 'Codex conversation' })).toBeVisible();
  await expect(page.locator('.xterm')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('How many orders?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('<img src=x onerror=alert(1)> 99 orders');
  await expect(page.getByRole('log').locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel response' }).click();
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toBeEnabled();
  const initialConnections = connection;
  closeSocket();
  await expect(page.getByRole('button', { name: /Reconnect$/ })).toBeEnabled();
  await page.getByRole('button', { name: /Reconnect$/ }).click();
  await expect(page.getByText('Earlier conversation was truncated; showing the retained tail.')).toBeVisible();
  // Development StrictMode rehearses each mount; reconnect creates one new mount.
  expect(connection).toBe(initialConnections * 2);
  expect(commands).toEqual([{ type: 'prompt', text: 'How many orders?' }, { type: 'interrupt' }]);
  if (ending === 'stop') {
    await page.getByRole('button', { name: /Stop$/ }).click();
    await expect(page.getByText('Session stopped')).toBeVisible();
  } else {
    failSocket();
    await expect(page.getByText('Session failed')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Codex conversation' })).toHaveCount(0);
  }
});
}
