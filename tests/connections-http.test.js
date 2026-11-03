import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCodeStory} from '../src/server/index.js';
import {analyze} from '../src/parser.js';

// These are invented test credentials, never usable provider keys.
const ALICE_KEY = 'sk-proj-fixture-alice-00000000000000000000';
const BOB_KEY = 'sk-proj-fixture-bob-0000000000000000000000';
const CLAUDE_KEY = 'sk-ant-api03-fixture-00000000000000000000';
const GEMINI_KEY = 'AIza-fixture-google-000000000000000000000';
const REJECTED_KEY = 'sk-proj-fixture-rejected-000000000000000';
const code = 'def kilometers_to_miles(km):\n    return km * 0.621371\n\nif __name__ == "__main__":\n    print(kilometers_to_miles(5))\n';
const parsed = analyze(code, 'distance.py');
const story = {
  overview: 'Converts five kilometers to miles and prints the result when the file runs directly.',
  conceptOrder: parsed.concepts, flowOrder: parsed.flow,
  chapters: parsed.chunks.map(chunk => ({id: chunk.id, title: 'Convert and display a distance',
    beginner: 'kilometers_to_miles multiplies a distance in kilometers by 0.621371 and returns miles. The main guard prints a conversion only when this file runs directly.',
    developer: 'The helper returns km * 0.621371; the guarded caller passes 5 and prints the result.',
    concept: 'Unit conversion', term: 'A return value is the result sent to a caller.',
    storyBeginner: 'In the workshop metaphor, kilometers_to_miles receives a distance and sends back miles. This describes static source, not an observed run.',
    storyDeveloper: 'The kilometers_to_miles worker returns the multiplied distance to its caller. The workshop handoff represents the real return value.'})),
  functions: parsed.symbols.map(symbol => ({id: symbol.id,
    purpose: 'Multiply km by 0.621371 and return the converted distance.',
    sideEffects: 'No state changes or I/O inside the helper.', caveats: 'The caller must provide a value that supports multiplication by a float.',
    storyBeginner: 'The kilometers_to_miles worker converts the delivered distance and returns the result.',
    storyDeveloper: 'The kilometers_to_miles worker returns the product; no I/O occurs inside the helper.'})),
  limitations: [], narrative: {available:true,reason:'',metaphor: 'workshop',
    premise: 'This workshop metaphor explains static source relationships, not observed execution.',
    overview: 'The conversion worker returns miles; the guarded print operation can display that result.', relationships: []}
};
const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
const openAIStream = () => new Response(
  event({type: 'response.output_text.delta', delta: JSON.stringify(story)}) +
  event({type: 'response.completed', response: {id: 'fixture-response', usage: {input_tokens: 30, output_tokens: 100}}}),
  {headers: {'Content-Type': 'text/event-stream'}}
);

function providerFixture() {
  const requests = [], inference = [];
  const fetcher = async (input, options = {}) => {
    const url = new URL(String(input)), headers = new Headers(options.headers);
    const provider = url.hostname === 'api.openai.com' ? 'openai' : url.hostname === 'api.anthropic.com' ? 'anthropic' : url.hostname === 'generativelanguage.googleapis.com' ? 'gemini' : null;
    assert.ok(provider, 'Test attempted an unexpected provider endpoint');
    const key = provider === 'openai' ? (headers.get('authorization') || '').replace(/^Bearer /, '') : provider === 'anthropic' ? headers.get('x-api-key') : headers.get('x-goog-api-key') || url.searchParams.get('key');
    assert.ok([ALICE_KEY, BOB_KEY, CLAUDE_KEY, GEMINI_KEY, REJECTED_KEY].includes(key), 'Provider request must use an invented fixture key');
    requests.push({provider, key, url: url.pathname});
    if (key === REJECTED_KEY) return Response.json({error: {code: 'invalid_api_key', message: 'Rejected fixture key: ' + key}}, {status: 401});
    if (url.pathname.endsWith('/models')) {
      if (provider === 'openai') return Response.json({data: [{id: 'gpt-fixture', object: 'model', owned_by: 'openai'}]});
      if (provider === 'anthropic') return Response.json({data: [{id: 'claude-fixture', display_name: 'Fixture Claude', type: 'model'}], has_more: false});
      return Response.json({models: [{name: 'models/gemini-fixture', displayName: 'Fixture Gemini', supportedGenerationMethods: ['generateContent']}]});
    }
    const request = JSON.parse(options.body); inference.push({provider, key, request});
    if (provider === 'openai') {assert.match(url.pathname, /\/responses$/); return openAIStream();}
    if (provider === 'anthropic') {
      assert.match(url.pathname, /\/messages$/);
      return Response.json({id: 'fixture-message', type: 'message', role: 'assistant', model: 'claude-fixture', content: [{type: 'text', text: JSON.stringify(story)}], stop_reason: 'end_turn', usage: {input_tokens: 30, output_tokens: 100}});
    }
    assert.match(url.pathname, /\/models\/gemini-fixture:generateContent$/);
    return Response.json({candidates: [{content: {role: 'model', parts: [{text: JSON.stringify(story)}]}, finishReason: 'STOP'}], usageMetadata: {promptTokenCount: 30, candidatesTokenCount: 100, totalTokenCount: 130}});
  };
  return {fetcher, requests, inference};
}
async function start(t, fetcher, dataDir = null) {
  const dir = dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'codestory-connections-'));
  const app = await createCodeStory({port: 0, root: process.cwd(), dataDir: dir, fetcher, browserOpener: async () => true});
  t.after(async () => {app.server.closeAllConnections(); await app.close(); if (!dataDir) await fs.rm(dir, {recursive: true, force: true});});
  const status = () => fetch(app.origin + '/api/status').then(response => response.json());
  const initial = await status();
  const post = (route, body, token = initial.csrfToken, origin = app.origin) => fetch(app.origin + route, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json', 'X-CodeStory-Token': token}, body: JSON.stringify(body)});
  return {app, dir, status, post};
}
async function connect(client, provider, key, label) {
  const response = await client.post('/api/connections/api', {provider, key, label, billingConsent: true});
  const data = await response.json();
  assert.equal(response.status, 200, data.error || 'Connection creation failed');
  assert.ok(data.connection?.id);
  const selected = await client.post('/api/connections/select', {id: data.connection.id});
  assert.equal(selected.status, 200);
  return data.connection;
}
async function readOwnFixtureFiles(dir) {
  let result = '';
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    result += entry.isDirectory() ? await readOwnFixtureFiles(file) : await fs.readFile(file, 'utf8');
  }
  return result;
}

test('fresh local users have isolated connections and CSRF sessions, with no credentials in public status or disk', async t => {
  const fixtures = providerFixture();
  const alice = await start(t, fixtures.fetcher), bob = await start(t, fixtures.fetcher);
  const aliceInitial = await alice.status(), bobInitial = await bob.status();
  assert.equal(aliceInitial.connection, null); assert.equal(bobInitial.connection, null);
  assert.deepEqual(aliceInitial.apiConnections, []); assert.deepEqual(bobInitial.apiConnections, []);
  assert.notEqual(aliceInitial.csrfToken, bobInitial.csrfToken);
  assert.equal((await bob.post('/api/connections/api', {provider: 'openai', key: BOB_KEY, billingConsent: true}, aliceInitial.csrfToken)).status, 403);
  assert.equal((await alice.post('/api/connections/api', {provider: 'openai', key: ALICE_KEY, billingConsent: true}, aliceInitial.csrfToken, 'https://other.example')).status, 403);
  assert.equal(fixtures.requests.length, 0);
  const missingConsent = await alice.post('/api/connections/api', {provider: 'openai', key: ALICE_KEY, label: 'Alice'});
  assert.equal(missingConsent.status, 400); assert.equal(fixtures.requests.length, 0);

  const aliceConnection = await connect(alice, 'openai', ALICE_KEY, 'Alice key');
  assert.deepEqual((await bob.status()).apiConnections, []);
  assert.equal((await fetch(bob.app.origin + '/api/models')).status, 401);
  const bobConnection = await connect(bob, 'openai', BOB_KEY, 'Bob key');
  assert.notEqual(aliceConnection.id, bobConnection.id);
  assert.equal((await alice.status()).apiConnections.length, 1);
  assert.equal((await bob.status()).apiConnections.length, 1);
  assert.equal((await bob.post('/api/connections/select', {id: aliceConnection.id})).status, 404);
  assert.equal((await bob.post('/api/connections/remove', {id: aliceConnection.id})).status, 404);
  for (const client of [alice, bob]) {
    const publicText = JSON.stringify(await client.status());
    const diskText = await readOwnFixtureFiles(client.dir);
    for (const secret of [ALICE_KEY, BOB_KEY]) {assert.ok(!publicText.includes(secret)); assert.ok(!diskText.includes(secret));}
    assert.ok(!publicText.includes('access_token'));
  }
});

test('HTTP connection routes dispatch verified models and explanations to each selected provider without sharing cached stories', async t => {
  const fixtures = providerFixture(), client = await start(t, fixtures.fetcher);
  const connections = [];
  for (const [provider, key] of [['openai', ALICE_KEY], ['anthropic', CLAUDE_KEY], ['gemini', GEMINI_KEY]]) {
    const connection = await connect(client, provider, key, 'Fixture ' + provider); connections.push(connection);
    const catalogResponse = await fetch(client.app.origin + '/api/models'); assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json(); assert.ok(catalog.models.length);
    const analysisBody = {code, filename: 'distance.py', model: catalog.models[0].id, connectionId: connection.id, consent: true};
    const before = fixtures.inference.length;
    const noConsent = await client.post('/api/analyze', {...analysisBody, consent: false}); assert.equal(noConsent.status, 400); assert.equal(fixtures.inference.length, before);
    const response = await client.post('/api/analyze', analysisBody), result = await response.json();
    assert.equal(response.status, 200, result.error || 'Analysis failed'); assert.equal(result.cached, false);
    assert.equal(result.story.overview, story.overview); assert.equal(fixtures.inference.at(-1).provider, provider); assert.equal(fixtures.inference.at(-1).key, key);
    const cached = await client.post('/api/analyze', analysisBody); assert.equal(cached.status, 200); assert.equal((await cached.json()).cached, true); assert.equal(fixtures.inference.length, before + 1);
    assert.ok(!JSON.stringify(result).includes(key));
  }
  assert.equal((await client.status()).apiConnections.length, 3);
  const current = (await client.status()).connection;
  const stale = await client.post('/api/analyze', {code, filename: 'distance.py', model: 'gpt-fixture', connectionId: connections[0].id, consent: true});
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'connection_changed');
  assert.equal((await client.post('/api/connections/remove', {id: connections[0].id})).status, 200);
  assert.equal((await client.status()).connection.id, current.id);
  assert.equal((await client.status()).apiConnections.length, 2);
});

test('rejected API keys are neither reflected in errors nor added to a connection', async t => {
  const fixtures = providerFixture(), client = await start(t, fixtures.fetcher);
  const response = await client.post('/api/connections/api', {provider: 'openai', key: REJECTED_KEY, label: 'Rejected fixture', billingConsent: true});
  assert.equal(response.status, 401);
  const text = await response.text(); assert.ok(!text.includes(REJECTED_KEY));
  assert.deepEqual((await client.status()).apiConnections, []); assert.equal((await client.status()).connection, null);
  assert.ok(!(await readOwnFixtureFiles(client.dir)).includes(REJECTED_KEY));
});

test('a running API analysis blocks account changes and cancellation releases the connection', async t => {
  const fixtures = providerFixture();
  let signalStarted;
  const started = new Promise(resolve => {signalStarted = resolve;});
  const fetcher = (input, options = {}) => {
    if (new URL(String(input)).pathname.endsWith('/responses')) {
      signalStarted();
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
      });
    }
    return fixtures.fetcher(input, options);
  };
  const client = await start(t, fetcher);
  const openai = await connect(client, 'openai', ALICE_KEY, 'Fixture OpenAI');
  const claude = await connect(client, 'anthropic', CLAUDE_KEY, 'Fixture Claude');
  assert.equal((await client.post('/api/connections/select', {id: openai.id})).status, 200);
  const localStatus = await client.status(), controller = new AbortController();
  t.after(() => controller.abort());
  const pending = fetch(client.app.origin + '/api/analyze', {method: 'POST',
    headers: {Origin: client.app.origin, 'Content-Type': 'application/json', 'X-CodeStory-Token': localStatus.csrfToken},
    body: JSON.stringify({code, filename: 'distance.py', model: 'gpt-fixture', connectionId: openai.id, consent: true}), signal: controller.signal});
  const pendingOutcome = pending.then(response => ({response}), error => ({error}));
  await Promise.race([started, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Fixture inference did not start')), 3000).unref())]);
  assert.equal((await client.status()).busy, true);
  for (const [route, body] of [
    ['/api/connections/select', {id: claude.id}],
    ['/api/connections/remove', {id: openai.id}],
    ['/api/auth/switch', {profileId: 'nonexistent-fixture'}],
    ['/api/auth/signout', {}]
  ]) {
    const response = await client.post(route, body); assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'connection_busy');
  }
  controller.abort(); assert.equal((await pendingOutcome).error?.name, 'AbortError');
  let status;
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await client.status(); if (!status.busy) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status.busy, false);
  assert.equal((await client.post('/api/connections/select', {id: claude.id})).status, 200);
});

test('restarting the local server does not restore process-memory API keys', async t => {
  const fixtures = providerFixture(), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codestory-restart-'));
  let activeApp;
  t.after(async () => {if (activeApp) await activeApp.close(); await fs.rm(dir, {recursive: true, force: true});});
  activeApp = await createCodeStory({port: 0, root: process.cwd(), dataDir: dir, fetcher: fixtures.fetcher, browserOpener: async () => true});
  const status = await (await fetch(activeApp.origin + '/api/status')).json();
  const setup = await fetch(activeApp.origin + '/api/connections/api', {method: 'POST', headers: {Origin: activeApp.origin, 'Content-Type': 'application/json', 'X-CodeStory-Token': status.csrfToken}, body: JSON.stringify({provider: 'openai', key: ALICE_KEY, label: 'Transient fixture', billingConsent: true})});
  assert.equal(setup.status, 200); assert.equal((await (await fetch(activeApp.origin + '/api/status')).json()).apiConnections.length, 1);
  await activeApp.close(); activeApp = null;
  assert.ok(!(await readOwnFixtureFiles(dir)).includes(ALICE_KEY));
  activeApp = await createCodeStory({port: 0, root: process.cwd(), dataDir: dir, fetcher: fixtures.fetcher, browserOpener: async () => true});
  const restarted = await (await fetch(activeApp.origin + '/api/status')).json();
  assert.deepEqual(restarted.apiConnections, []); assert.equal(restarted.connection, null);
  assert.equal((await fetch(activeApp.origin + '/api/models')).status, 401);
});
