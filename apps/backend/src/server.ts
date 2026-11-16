import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { clientEventSchema, GREETING, type ServerEvent } from '../../../packages/shared/index';
import { StudioData } from './data';
import { StudioAgent } from './agent';
import { VoiceWorker } from './voice';
import { isPlaybackEcho } from './echo';

export interface VoicePort {
  ready: boolean;
  send(event: Record<string, unknown>): void;
  on(name: string, handler: (event: any) => void): unknown;
  start(): void;
  close(): Promise<void>;
}
type Session = {
  id: string;
  started: boolean;
  closed: boolean;
  created: number;
  ws: WebSocket | null;
  turn: number;
  controller: AbortController | null;
  agent: StudioAgent;
  speaking: boolean;
  requestAt: number;
  firstAudio: boolean;
  lastSpoken: string;
  echoUntil: number;
  audioSeconds: number;
  audioStartedAt: number;
};
export async function createServer(
  options: {
    root?: string;
    port?: number;
    llmUrl?: string;
    voice?: VoicePort;
    test?: boolean;
  } = {},
) {
  const root = options.root ?? process.env.KRUGI_ROOT ?? process.cwd();
  const data = new StudioData(root);
  const voice = options.voice ?? new VoiceWorker(root);
  const llmUrl = options.llmUrl ?? process.env.LLM_URL ?? 'http://127.0.0.1:8150';
  class AppModule {}
  Module({})(AppModule);
  const app = await NestFactory.create(AppModule, { logger: false });
  const sessions = new Map<string, Session>();
  let active: string | null = null;
  let nextTurn = 0;
  const send = (s: Session, e: ServerEvent) => {
    if (!s.closed && s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(e));
  };
  const interrupt = (s: Session) => {
    const turn = s.turn;
    s.controller?.abort();
    s.controller = null;
    s.speaking = false;
    try {
      voice.send({ type: 'cancel', sessionId: s.id, turnId: turn });
    } catch {
      /* cancelling is best effort when worker failed */
    }
    s.turn = ++nextTurn;
    send(s, { type: 'interrupted', turnId: turn });
    send(s, { type: 'status', status: 'listening' });
  };
  const stop = (s: Session) => {
    if (s.closed) return;
    try {
      interrupt(s);
      voice.send({ type: 'asr_stop', sessionId: s.id });
    } catch {
      /* worker may be down */
    }
    s.closed = true;
    s.ws?.close(1000);
    sessions.delete(s.id);
    if (active === s.id) active = null;
  };
  const speak = (s: Session, text: string) => {
    s.speaking = true;
    s.lastSpoken = text;
    s.echoUntil = Date.now() + text.length * 120 + 2000;
    s.audioSeconds = 0;
    s.audioStartedAt = 0;
    send(s, { type: 'status', status: 'speaking' });
    send(s, { type: 'assistant', text, turnId: s.turn });
    voice.send({ type: 'tts', sessionId: s.id, turnId: s.turn, text });
  };
  const respond = async (s: Session, text: string) => {
    interrupt(s);
    s.requestAt = performance.now();
    s.firstAudio = true;
    const turn = s.turn;
    const controller = new AbortController();
    s.controller = controller;
    send(s, { type: 'status', status: 'searching' });
    try {
      const reply = await s.agent.respond(text, controller.signal);
      if (s.closed || turn !== s.turn || controller.signal.aborted) return;
      speak(s, reply);
    } catch (error) {
      if (controller.signal.aborted || s.closed || turn !== s.turn) return;
      send(s, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Ошибка локальной модели',
      });
      send(s, { type: 'status', status: 'error' });
    }
  };
  const http = app.getHttpAdapter().getInstance();
  app.use((req: any, res: any, next: () => void) => {
    const origin = req.headers.origin;
    const host = req.headers.host?.split(':')[0];
    if (
      !['127.0.0.1', 'localhost'].includes(host) ||
      (origin && !['http://127.0.0.1:9150', 'http://localhost:9150'].includes(origin))
    ) {
      res.status(403).json({ message: 'Доступ только локальному приложению' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  http.get('/api/catalog', (_req: any, res: any) =>
    res.json({ demo: true, programs: data.programs }),
  );
  http.get('/api/health', async (_req: any, res: any) => {
    let llm = false;
    try {
      llm = (await fetch(llmUrl + '/health', { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      /* unavailable */
    }
    res
      .status(llm && voice.ready ? 200 : 503)
      .json({ status: llm && voice.ready ? 'ok' : 'error', llm, voice: voice.ready });
  });
  http.post('/api/sessions', (_req: any, res: any) => {
    for (const s of sessions.values())
      if (!s.ws && Date.now() - s.created > 60_000) sessions.delete(s.id);
    if (sessions.size >= 8) {
      res.status(429).json({ message: 'Завершите предыдущий разговор' });
      return;
    }
    const id = randomUUID();
    const s: Session = {
      id,
      started: false,
      closed: false,
      created: Date.now(),
      ws: null,
      turn: 0,
      controller: null,
      speaking: false,
      requestAt: 0,
      firstAudio: false,
      lastSpoken: '',
      echoUntil: 0,
      audioSeconds: 0,
      audioStartedAt: 0,
      agent: null!,
    };
    s.agent = new StudioAgent(data, (e) => send(s, e), llmUrl);
    sessions.set(id, s);
    res.status(201).json({ id });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 131072 });
  app.getHttpServer().on('upgrade', (req: any, socket: any, head: any) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin;
    if (
      url.pathname != '/ws' ||
      (origin && !['http://127.0.0.1:9150', 'http://localhost:9150'].includes(origin))
    ) {
      socket.destroy();
      return;
    }
    const id = url.searchParams.get('sessionId') ?? url.searchParams.get('session');
    const s = id ? sessions.get(id) : undefined;
    if (!s || s.closed || s.ws) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, s));
  });
  wss.on('connection', (ws: WebSocket, s: Session) => {
    s.ws = ws;
    send(s, { type: 'ready' });
    ws.on('message', (raw, isBinary) => {
      try {
        if (isBinary) throw new Error('Ожидается JSON');
        const parsed = clientEventSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) throw new Error('Некорректное сообщение');
        const e = parsed.data;
        if (e.type === 'start') {
          if (s.started) return;
          if (!voice.ready) throw new Error('Голосовые модели ещё загружаются');
          if (active && active !== s.id) throw new Error('Уже идёт другой разговор');
          active = s.id;
          s.started = true;
          s.turn = ++nextTurn;
          s.requestAt = performance.now();
          s.firstAudio = true;
          voice.send({ type: 'asr_start', sessionId: s.id });
          speak(s, GREETING);
        } else if (e.type === 'stop') stop(s);
        else {
          if (!s.started) throw new Error('Сначала начните разговор');
          if (e.type === 'pcm') {
            const bytes = Buffer.from(e.audio, 'base64');
            if (bytes.length % 2 || bytes.length > 16000 || bytes.toString('base64') !== e.audio)
              throw new Error('Некорректный звук');
            voice.send({ type: 'pcm', sessionId: s.id, audio: e.audio });
          } else if (e.type === 'interrupt') {
            s.echoUntil = 0;
            interrupt(s);
          } else if (e.type === 'text') {
            send(s, { type: 'transcript', text: e.text, final: true });
            void respond(s, e.text);
          }
        }
      } catch (error) {
        send(s, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Некорректное сообщение',
        });
      }
    });
    ws.on('close', () => stop(s));
    ws.on('error', () => stop(s));
  });
  voice.on('message', (e: any) => {
    if (e.type === 'ready') return;
    if (e.type === 'error') {
      const affected = e.sessionId ? [sessions.get(e.sessionId)] : [...sessions.values()];
      for (const target of affected) {
        if (!target || target.closed || (e.turnId !== undefined && e.turnId !== target.turn))
          continue;
        interrupt(target);
        send(target, { type: 'error', message: e.message });
        send(target, { type: 'status', status: 'error' });
      }
      return;
    }
    const s = sessions.get(e.sessionId);
    if (!s || s.closed || !s.started) return;
    if (e.type === 'partial' || e.type === 'final') {
      if (!e.text) return;
      if (Date.now() < s.echoUntil && isPlaybackEcho(e.text, s.lastSpoken)) {
        send(s, {
          type: 'diagnostic',
          kind: 'echo',
          name: 'playback_suppressed',
          result: { text: e.text },
        });
        return;
      }
      send(s, { type: 'transcript', text: e.text, final: e.type === 'final' });
      if (e.type === 'final') void respond(s, e.text);
      else if (s.speaking && e.text.trim().split(/\s+/).length >= 4) interrupt(s);
    } else if (e.turnId === s.turn) {
      if (e.type === 'tts_text' && typeof e.text === 'string') {
        s.lastSpoken = e.text;
      } else if (e.type === 'audio') {
        if (!s.audioStartedAt) s.audioStartedAt = Date.now();
        s.audioSeconds += Buffer.from(e.audio, 'base64').length / 2 / e.sampleRate;
        s.echoUntil = s.audioStartedAt + s.audioSeconds * 1000 + 1500;
        if (s.firstAudio) {
          s.firstAudio = false;
          send(s, {
            type: 'diagnostic',
            kind: 'timing',
            name: 'request_to_first_audio',
            durationMs: performance.now() - s.requestAt,
          });
        }
        send(s, {
          type: 'audio',
          audio: e.audio,
          sampleRate: e.sampleRate,
          channels: 1,
          turnId: e.turnId,
        });
      } else if (e.type === 'tts_end') {
        s.speaking = false;
        send(s, { type: 'audio_end', turnId: s.turn });
        send(s, { type: 'status', status: 'listening' });
        send(s, {
          type: 'diagnostic',
          kind: 'timing',
          name: 'tts',
          durationMs: e.durationMs,
          result: { audioSeconds: e.audioSeconds },
        });
      } else if (e.type === 'error') {
        send(s, { type: 'error', message: e.message });
        send(s, { type: 'status', status: 'error' });
      }
    }
  });
  voice.on('failure', (message: string) => {
    for (const s of sessions.values()) {
      interrupt(s);
      send(s, { type: 'error', message });
      send(s, { type: 'status', status: 'error' });
    }
  });
  voice.start();
  await app.listen(options.port ?? Number(process.env.PORT ?? 3150), '127.0.0.1');
  const address = app.getHttpServer().address();
  return {
    app,
    port: typeof address === 'object' && address ? address.port : 0,
    data,
    sessions,
    async close() {
      for (const s of sessions.values()) stop(s);
      wss.close();
      await voice.close();
      await app.close();
    },
  };
}
if (
  process.env.KRUGI_RUN_SERVER === '1' ||
  (process.argv[1] && resolve(process.argv[1]).endsWith('server.cjs'))
) {
  void createServer()
    .then((server) => {
      console.log('Backend: http://127.0.0.1:' + server.port);
      const close = () => {
        void server.close().then(() => process.exit(0));
      };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
