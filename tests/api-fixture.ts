import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { createServer } from '../apps/backend/src/server';
import { GREETING, serverEventSchema, type ServerEvent } from '../packages/shared/index';

class FakeVoice extends EventEmitter {
  ready = true;
  calls: Record<string, unknown>[] = [];
  start() {}
  send(event: Record<string, unknown>) {
    if (!this.ready) throw new Error('voice down');
    this.calls.push(event);
  }
  async close() {
    this.ready = false;
  }
}

let stage = 'initialization';
const watchdog = setTimeout(() => {
  console.error(`API fixture timed out during ${stage}`);
  process.exit(1);
}, 12_000);

async function wait(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Event timeout during ${stage}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function main() {
  let llmRequests = 0;
  let llmUnavailable = false;
  const llmSockets = new Set<Socket>();
  const llm = createHttpServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(llmUnavailable ? 503 : 200);
      res.end('{}');
      return;
    }
    llmRequests++;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.resume();
    req.on('end', () =>
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(llmUnavailable ? 503 : 200, { 'Content-Type': 'application/json' });
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          tool_choice?: string;
          tools?: { function: { name: string } }[];
        };
        const name = body.tools?.[0]?.function.name;
        const args =
          name === 'search_knowledge'
            ? { query: 'без опыта' }
            : name === 'load_skill'
              ? { id: 'wheel' }
              : { programId: 'wheel' };
        const message =
          body.tool_choice === 'required' && name
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'api_test_call',
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              }
            : { role: 'assistant', content: 'Проверенный ответ.' };
        res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
      }, 150),
    );
  });
  llm.on('connection', (socket) => {
    llmSockets.add(socket);
    socket.once('close', () => llmSockets.delete(socket));
  });
  llm.listen(0, '127.0.0.1');
  await once(llm, 'listening');
  const address = llm.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock LLM port');
  const voice = new FakeVoice();
  const server = await createServer({
    root: process.cwd(),
    port: 0,
    llmUrl: `http://127.0.0.1:${address.port}`,
    voice,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const sockets = new Set<WebSocket>();
  async function request(path: string, init?: RequestInit) {
    const response = await fetch(base + path, init);
    const body: unknown = await response.json();
    return { status: response.status, body };
  }
  async function connect() {
    const response = await request('/api/sessions', { method: 'POST' });
    assert.equal(response.status, 201);
    const id = (response.body as { id: string }).id;
    assert.equal(typeof id, 'string');
    const events: ServerEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?session=${id}`);
    sockets.add(ws);
    ws.once('close', () => sockets.delete(ws));
    ws.on('message', (raw) =>
      events.push(serverEventSchema.parse(JSON.parse(raw.toString())) as ServerEvent),
    );
    await once(ws, 'open');
    await wait(() => events.some((event) => event.type === 'ready'));
    return { id, events, ws, send: (event: unknown) => ws.send(JSON.stringify(event)) };
  }
  try {
    stage = 'HTTP health and origin validation';
    assert.equal((await request('/api/health')).status, 200);
    assert.equal(
      (
        await request('/api/sessions', {
          method: 'POST',
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    const first = await connect();
    stage = 'pre-start validation';
    first.send({ type: 'text', text: 'до старта' });
    await wait(() =>
      first.events.some((event) => event.type === 'error' && event.message.includes('Сначала')),
    );
    first.events.length = 0;
    stage = 'greeting exactly once';
    first.send({ type: 'start' });
    first.send({ type: 'start' });
    await wait(() => first.events.some((event) => event.type === 'assistant'));
    assert.deepEqual(
      first.events.filter((event) => event.type === 'assistant').map((event) => event.text),
      [GREETING],
    );
    assert.equal(voice.calls.filter((event) => event.type === 'asr_start').length, 1);
    const greeting = first.events.find((event) => event.type === 'assistant');
    if (!greeting || greeting.type !== 'assistant') throw new Error('Missing greeting');
    const oldTurn = greeting.turnId;
    stage = 'stale audio cancellation';
    first.send({ type: 'interrupt' });
    await wait(() =>
      first.events.some((event) => event.type === 'interrupted' && event.turnId === oldTurn),
    );
    voice.emit('message', {
      type: 'audio',
      sessionId: first.id,
      turnId: oldTurn,
      audio: 'AAA=',
      sampleRate: 48000,
      channels: 1,
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    assert.equal(
      first.events.some((event) => event.type === 'audio'),
      false,
    );
    stage = 'in-flight LLM cancellation';
    first.send({ type: 'text', text: 'Расскажите' });
    await wait(() => llmRequests > 0);
    first.send({ type: 'interrupt' });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.equal(first.events.filter((event) => event.type === 'assistant').length, 1);
    assert.ok(voice.calls.some((event) => event.type === 'cancel' && event.turnId === oldTurn));
    stage = 'PCM and voice error validation';
    first.send({ type: 'pcm', audio: 'AQ==' });
    await wait(() =>
      first.events.some((event) => event.type === 'error' && event.message === 'Некорректный звук'),
    );
    voice.emit('message', { type: 'error', sessionId: first.id, message: 'ASR test failure' });
    await wait(() =>
      first.events.some((event) => event.type === 'error' && event.message === 'ASR test failure'),
    );
    stage = 'successful tool response and audio forwarding';
    first.send({ type: 'text', text: 'Можно прийти без опыта?' });
    await wait(() =>
      first.events.some(
        (event) => event.type === 'assistant' && event.text.includes('Проверенный ответ.'),
      ),
    );
    const answer = first.events.find(
      (event) => event.type === 'assistant' && event.text.includes('Проверенный ответ.'),
    );
    if (!answer || answer.type !== 'assistant') throw new Error('Missing successful answer');
    assert.ok(
      first.events.some(
        (event) => event.type === 'diagnostic' && event.name === 'search_knowledge',
      ),
    );
    assert.ok(
      voice.calls.some(
        (event) =>
          event.type === 'tts' && event.turnId === answer.turnId && event.text === answer.text,
      ),
    );
    voice.emit('message', {
      type: 'audio',
      sessionId: first.id,
      turnId: answer.turnId,
      audio: 'AAA=',
      sampleRate: 48000,
      channels: 1,
    });
    await wait(() =>
      first.events.some(
        (event) =>
          event.type === 'audio' && event.turnId === answer.turnId && event.audio === 'AAA=',
      ),
    );
    voice.emit('message', {
      type: 'tts_end',
      sessionId: first.id,
      turnId: answer.turnId,
      durationMs: 1,
      audioSeconds: 0.1,
    });
    await wait(() =>
      first.events.some((event) => event.type === 'audio_end' && event.turnId === answer.turnId),
    );
    stage = 'unavailable language model';
    llmUnavailable = true;
    first.send({ type: 'text', text: 'Хочу узнать ещё кое-что' });
    await wait(() =>
      first.events.some((event) => event.type === 'error' && event.message.includes('503')),
    );
    assert.equal((await request('/api/health')).status, 503);
    llmUnavailable = false;
    stage = 'session cleanup and repeat start';
    const firstClose = once(first.ws, 'close');
    first.send({ type: 'stop' });
    await firstClose;
    assert.equal(server.sessions.size, 0);
    const second = await connect();
    second.send({ type: 'start' });
    await wait(() => second.events.some((event) => event.type === 'assistant'));
    assert.deepEqual(
      second.events.filter((event) => event.type === 'assistant').map((event) => event.text),
      [GREETING],
    );
    assert.equal(voice.calls.filter((event) => event.type === 'asr_start').length, 2);
    voice.emit('message', {
      type: 'audio',
      sessionId: first.id,
      turnId: oldTurn,
      audio: 'AAA=',
      sampleRate: 48000,
      channels: 1,
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    assert.equal(
      second.events.some((event) => event.type === 'audio'),
      false,
    );
    stage = 'worker failure';
    voice.ready = false;
    voice.emit('failure', 'worker failed');
    await wait(() =>
      second.events.some((event) => event.type === 'error' && event.message === 'worker failed'),
    );
    assert.equal((await request('/api/health')).status, 503);
    const secondClose = once(second.ws, 'close');
    second.send({ type: 'stop' });
    await secondClose;
    assert.equal(server.sessions.size, 0);
  } catch (error) {
    throw new Error(`API assertion during ${stage}`, { cause: error });
  } finally {
    stage = 'backend shutdown';
    for (const socket of sockets) socket.terminate();
    await server.close();
    stage = 'mock LLM shutdown';
    for (const connection of llmSockets) connection.destroy();
    await new Promise<void>((resolveClose) => llm.close(() => resolveClose()));
  }
}

void main()
  .then(() => {
    clearTimeout(watchdog);
    console.log('API checks passed');
  })
  .catch((error: unknown) => {
    clearTimeout(watchdog);
    console.error(`API fixture failed during ${stage}`, error);
    process.exit(1);
  });
