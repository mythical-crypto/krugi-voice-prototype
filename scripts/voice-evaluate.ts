import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GREETING, type ServerEvent } from '../packages/shared/index';

const root = process.cwd();
const api = 'http://127.0.0.1:3150';
const visitorQuestions = process.argv.includes('--visitor-questions');
const reportName = visitorQuestions ? 'visitor-voice-report.json' : 'e2e-voice-report.json';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Captured = { at: number; event: ServerEvent };

function fixture(name: string) {
  const bytes = readFileSync(
    join(root, visitorQuestions ? 'runtime/piper-fixtures-16k' : 'runtime/voice-fixtures', name),
  );
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Expected WAV');
  let rate = 0;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    if (kind === 'fmt ') {
      if (
        bytes.readUInt16LE(offset + 8) !== 1 ||
        bytes.readUInt16LE(offset + 10) !== 1 ||
        bytes.readUInt16LE(offset + 22) !== 16
      )
        throw new Error('Expected PCM16 mono fixture');
      rate = bytes.readUInt32LE(offset + 12);
    }
    if (kind === 'data') pcm = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + (length % 2);
  }
  if (!pcm || rate !== 16000) throw new Error('Expected 16kHz fixture');
  let lastActive = -1;
  for (let sample = 0; sample < pcm.length / 2; sample++)
    if (Math.abs(pcm.readInt16LE(sample * 2)) > 655) lastActive = sample;
  if (lastActive < 0) throw new Error('Silent fixture');
  return { pcm, rate, lastActive };
}

function firstActiveOffset(event: Extract<ServerEvent, { type: 'audio' }>) {
  const pcm = Buffer.from(event.audio, 'base64');
  for (let offset = 0; offset + 1 < pcm.length; offset += 2)
    if (Math.abs(pcm.readInt16LE(offset)) > 655) return (offset / 2 / event.sampleRate) * 1000;
  return null;
}

class Conversation {
  events: Captured[] = [];
  ws!: WebSocket;
  async open() {
    const response = await fetch(api + '/api/sessions', { method: 'POST' });
    if (!response.ok) throw new Error('Cannot create session: ' + response.status);
    const session = (await response.json()) as { id: string };
    this.ws = new WebSocket('ws://127.0.0.1:3150/ws?session=' + session.id, {
      origin: 'http://127.0.0.1:9150',
    });
    this.ws.on('message', (data) =>
      this.events.push({ at: performance.now(), event: JSON.parse(data.toString()) }),
    );
    await this.wait((e) => e.type === 'ready');
    this.send({ type: 'start' });
    return this;
  }
  send(event: Record<string, unknown>) {
    this.ws.send(JSON.stringify(event));
  }
  async wait(predicate: (event: ServerEvent) => boolean, from = 0, timeout = 60000) {
    const until = performance.now() + timeout;
    while (performance.now() < until) {
      const slice = this.events.slice(from);
      const error = slice.find((entry) => entry.event.type === 'error');
      if (error) throw new Error(JSON.stringify(error.event));
      const found = slice.find((entry) => predicate(entry.event));
      if (found) return found;
      if (this.ws.readyState === WebSocket.CLOSED) throw new Error('Socket closed before response');
      await delay(10);
    }
    throw new Error('Voice response timed out');
  }
  async waitPlayback(turn: number, from = 0, echoTail = 1700) {
    await this.wait((e) => e.type === 'audio_end' && e.turnId === turn, from);
    const audio = this.events
      .slice(from)
      .filter((entry) => entry.event.type === 'audio' && entry.event.turnId === turn);
    let until = 0;
    for (const entry of audio) {
      const event = entry.event as Extract<ServerEvent, { type: 'audio' }>;
      until =
        Math.max(until, entry.at) +
        (Buffer.from(event.audio, 'base64').length / 2 / event.sampleRate) * 1000;
    }
    await delay(Math.max(0, until + echoTail - performance.now()));
  }
  async feed(name: string) {
    const input = fixture(name);
    const pcm = Buffer.concat([input.pcm, Buffer.alloc(32000 * 2)]);
    const start = performance.now();
    let lastSpeechAt = 0;
    for (let offset = 0; offset < pcm.length; offset += 2560) {
      const due = start + (offset / 2 / 16000) * 1000;
      await delay(Math.max(0, due - performance.now()));
      const chunk = pcm.subarray(offset, offset + 2560);
      const sentAt = performance.now();
      this.send({ type: 'pcm', audio: chunk.toString('base64') });
      const firstSample = offset / 2;
      const sampleCount = chunk.length / 2;
      if (input.lastActive >= firstSample && input.lastActive < firstSample + sampleCount)
        lastSpeechAt = sentAt - ((firstSample + sampleCount - 1 - input.lastActive) / 16000) * 1000;
    }
    return { lastSpeechAt, fixtureSeconds: input.pcm.length / 2 / input.rate };
  }
  async loopback(turnId: number) {
    let cursor = 0;
    let ended = false;
    let pending: Buffer = Buffer.alloc(0);
    let samplesSent = 0;
    let started = 0;
    const deadline = performance.now() + 60000;
    while (!ended || pending.length) {
      if (performance.now() > deadline) throw new Error('Playback loopback timed out');
      for (const entry of this.events.slice(cursor)) {
        const event = entry.event;
        if (event.type === 'audio' && event.turnId === turnId) {
          const ratio = event.sampleRate / 16000;
          const pcm = Buffer.from(event.audio, 'base64');
          const output = Buffer.alloc(Math.floor(pcm.length / 2 / ratio) * 2);
          for (let sample = 0; sample < output.length / 2; sample++) {
            const position = sample * ratio;
            const lower = Math.floor(position);
            const upper = Math.min(lower + 1, pcm.length / 2 - 1);
            const alpha = position - lower;
            output.writeInt16LE(
              Math.round(
                pcm.readInt16LE(lower * 2) * (1 - alpha) + pcm.readInt16LE(upper * 2) * alpha,
              ),
              sample * 2,
            );
          }
          pending = Buffer.concat([pending, output]);
        }
        if (event.type === 'audio_end' && event.turnId === turnId) ended = true;
      }
      cursor = this.events.length;
      if (pending.length < 2560 && !ended) {
        await delay(5);
        continue;
      }
      if (!pending.length) break;
      if (!started) started = performance.now();
      await delay(Math.max(0, started + (samplesSent / 16000) * 1000 - performance.now()));
      const chunk = pending.subarray(0, 2560);
      pending = pending.subarray(chunk.length);
      this.send({ type: 'pcm', audio: chunk.toString('base64') });
      samplesSent += chunk.length / 2;
    }
    for (let index = 0; index < 25; index++) {
      await delay(Math.max(0, started + (samplesSent / 16000) * 1000 - performance.now()));
      this.send({ type: 'pcm', audio: Buffer.alloc(2560).toString('base64') });
      samplesSent += 1280;
    }
    return {
      loopbackSeconds: samplesSent / 16000 - 2,
      source: 'Actual current TTS output packets resampled to16k and paced at playback speed',
    };
  }
  close() {
    if (this.ws.readyState === WebSocket.OPEN) this.send({ type: 'stop' });
    this.ws.close();
  }
  saveAudio(turnId: number, name: string) {
    const events = this.events.flatMap(({ event }) =>
      event.type === 'audio' && event.turnId === turnId ? [event] : [],
    );
    if (!events.length) throw new Error('No recorded audio for ' + name);
    const pcm = Buffer.concat(events.map((event) => Buffer.from(event.audio, 'base64')));
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(pcm.length + 36, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(events[0].sampleRate, 24);
    header.writeUInt32LE(events[0].sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    const directory = join(root, 'runtime/e2e-voice-fixtures');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name + '.wav'), Buffer.concat([header, pcm]));
  }
  summary(from = 0) {
    return this.events.slice(from).map(({ at, event }) => {
      if (event.type !== 'audio') return { atMs: Math.round(at), ...event };
      return {
        atMs: Math.round(at),
        type: event.type,
        turnId: event.turnId,
        sampleRate: event.sampleRate,
        samples: Buffer.from(event.audio, 'base64').length / 2,
      };
    });
  }
}

const echoOnly = process.argv.includes('--echo-only');
const previous: Record<string, any> = echoOnly
  ? JSON.parse(readFileSync(join(root, 'runtime/e2e-voice-report.json'), 'utf8'))
  : {};
const report: Record<string, any> = {
  measuredAt: new Date().toISOString(),
  transport: 'Real paced PCM16 over application WebSocket → Vosk → Qwen/tools → Piper RU ONNX',
  timingDefinition:
    'Recorded last sample above amplitude 655 (2%) at capture-frame send minus remaining frame duration → received first non-silent reply packet plus onset offset. Includes Vosk endpointing; excludes physical microphone, browser playback buffer and DAC.',
  samples: [],
  timingQuantizationBoundMs: 80,
  failures: [],
  physicalMicrophoneTested: false,
  ...previous,
};
if (echoOnly) {
  report.echoBeforeFix ??= { failures: report.failures, events: report.echoEvents };
  report.echoRetestedAt = new Date().toISOString();
}
const save = () =>
  writeFileSync(join(root, 'runtime', reportName), JSON.stringify(report, null, 2) + '\n');
let conversation: Conversation | undefined;
try {
  const until = performance.now() + 60000;
  let ready = false;
  while (performance.now() < until) {
    try {
      ready = (await fetch(api + '/api/health')).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error('Application health did not become ready within 60s');
  if (!echoOnly) {
    conversation = await new Conversation().open();
    const greeting = await conversation.wait((e) => e.type === 'assistant');
    const greetingEvent = greeting.event as Extract<ServerEvent, { type: 'assistant' }>;
    if (greetingEvent.text !== GREETING)
      throw new Error('Greeting differs from exact required text');
    conversation.send({ type: 'start' });
    await conversation.waitPlayback(greetingEvent.turnId);
    conversation.saveAudio(greetingEvent.turnId, 'greeting');
    report.exactGreeting = greetingEvent.text;
    report.sameSessionStartDoesNotRepeatGreeting =
      conversation.events.filter(
        (entry) => entry.event.type === 'assistant' && entry.event.text === GREETING,
      ).length === 1;

    for (let index = 0; index < 4; index++) {
      const from = conversation.events.length;
      const name = visitorQuestions
        ? [
            'visitor-hearing.wav',
            'visitor-prices.wav',
            'visitor-correction.wav',
            'visitor-wheel.wav',
          ][index]!
        : index === 0
          ? 'visitor-16k.wav'
          : 'faq-16k.wav';
      const input = await conversation.feed(name);
      const transcript = await conversation.wait((e) => e.type === 'transcript' && e.final, from);
      const reply = await conversation.wait(
        (e) => e.type === 'assistant' && e.text !== GREETING,
        from,
      );
      const assistant = reply.event as Extract<ServerEvent, { type: 'assistant' }>;
      if (visitorQuestions) {
        const expected = index === 0 ? ['слышу'] : index < 3 ? ['3200', '2800', '5600'] : ['3200'];
        for (const value of expected)
          if (!assistant.text.includes(value))
            throw new Error('Visitor question did not receive required answer: ' + value);
      }
      if (/^(сейчас|секунду|проверю|подождите)[.!\s]*$/i.test(assistant.text))
        throw new Error('Filler response cannot count as substantive audio');
      const sound = await conversation.wait(
        (e) => e.type === 'audio' && e.turnId === assistant.turnId && firstActiveOffset(e) !== null,
        from,
      );
      const audio = sound.event as Extract<ServerEvent, { type: 'audio' }>;
      const onsetMs = firstActiveOffset(audio)!;
      const item = {
        sample: index,
        fixture: name,
        fixtureSeconds: input.fixtureSeconds,
        asr: (transcript.event as Extract<ServerEvent, { type: 'transcript' }>).text,
        reply: assistant.text,
        endSpeechToAsrFinalMs: Math.round(transcript.at - input.lastSpeechAt),
        endSpeechToFirstContentAudioMs: Math.round(sound.at + onsetMs - input.lastSpeechAt),
        asrFinalToFirstContentAudioMs: Math.round(sound.at + onsetMs - transcript.at),
        contentOnsetInPacketMs: Math.round(onsetMs),
        turnId: assistant.turnId,
      };
      report.samples.push(item);
      save();
      console.log(JSON.stringify(item));
      if (index === 3) {
        const cancelledAt = performance.now();
        conversation.send({ type: 'interrupt' });
        const interrupted = await conversation.wait(
          (e) => e.type === 'interrupted' && e.turnId === assistant.turnId,
          from,
        );
        await delay(400);
        report.interruptAckMs = Math.round(interrupted.at - cancelledAt);
        report.staleAudioAfterCancel = conversation.events.filter(
          (entry) =>
            entry.at > interrupted.at &&
            entry.event.type === 'audio' &&
            entry.event.turnId === assistant.turnId,
        ).length;
        if (report.staleAudioAfterCancel)
          report.failures.push('Stale audio emitted after interrupt acknowledgement');
      } else {
        await conversation.waitPlayback(assistant.turnId, from);
      }
      conversation.saveAudio(assistant.turnId, 'reply-' + index);
    }
    report.callsAndEvents = conversation.summary();
    report.warmedFaqMedianMs = report.samples
      .slice(1)
      .map((sample: any) => sample.endSpeechToFirstContentAudioMs)
      .sort((a: number, b: number) => a - b)[1];
    report.toolsUsed = [
      ...new Set(
        conversation.events.flatMap(({ event }) =>
          event.type === 'diagnostic' && event.kind === 'tool' ? [event.name] : [],
        ),
      ),
    ];
    report.sourcesUsed = conversation.events.flatMap(({ event }) =>
      event.type === 'diagnostic' && event.name === 'search_knowledge' ? [event.result] : [],
    );
    report.quote = conversation.events
      .filter(({ event }) => event.type === 'quote' && event.quote)
      .at(-1)?.event;
    if (!report.quote) report.failures.push('No actual quote from voice dialogue');
    conversation.close();
  }
  conversation = await new Conversation().open();
  const repeated = await conversation.wait((e) => e.type === 'assistant');
  report.newSessionRepeatsExactGreeting =
    repeated.event.type === 'assistant' && repeated.event.text === GREETING;
  if (!report.newSessionRepeatsExactGreeting)
    throw new Error('Greeting differs from exact required text');
  await conversation.wait((e) => e.type === 'audio');
  const echoStart = conversation.events.length;
  if (repeated.event.type !== 'assistant') throw new Error('No greeting turn');
  report.echoInput = await conversation.loopback(repeated.event.turnId);
  conversation.saveAudio(repeated.event.turnId, 'loopback-greeting');
  await delay(300);
  report.echoEvents = conversation.summary(echoStart);
  report.respondedToPlayback = conversation.events
    .slice(echoStart)
    .some(
      ({ event }) =>
        event.type === 'assistant' ||
        (event.type === 'status' && event.status === 'searching') ||
        (event.type === 'diagnostic' && event.kind === 'tool'),
    );
  report.falseInterruptionsOnPlayback = conversation.events
    .slice(echoStart)
    .filter(({ event }) => event.type === 'interrupted').length;
  if (report.respondedToPlayback) report.failures.push('Assistant responded to its own playback');
  if (report.falseInterruptionsOnPlayback)
    report.failures.push('Playback falsely interrupted greeting');
  if (echoOnly && !report.respondedToPlayback && !report.falseInterruptionsOnPlayback)
    report.failures = report.failures.filter(
      (failure: string) => !/playback|greeting/i.test(failure),
    );
} catch (error) {
  report.failures.push(String(error));
  if (conversation) report.lastEvents = conversation.summary();
} finally {
  conversation?.close();
  save();
}
if (report.failures.length) process.exitCode = 1;
console.log(
  JSON.stringify({
    warmedFaqMedianMs: report.warmedFaqMedianMs,
    interruptAckMs: report.interruptAckMs,
    failures: report.failures,
  }),
);
