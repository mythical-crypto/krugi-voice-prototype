'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
async function main() {
  const health = await fetch('http://127.0.0.1:3150/api/health').then((r) => r.json());
  assert.equal(health.llm, true);
  assert.equal(health.voice, true);
  const page = await fetch('http://127.0.0.1:9150/').then((r) => r.text());
  assert.match(page, /<html/);
  const session = await fetch('http://127.0.0.1:3150/api/sessions', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:9150' },
  }).then((r) => r.json());
  const ws = new WebSocket('ws://127.0.0.1:3150/ws?session=' + session.id, {
    origin: 'http://127.0.0.1:9150',
  });
  const events = [];
  let waiter;
  ws.on('message', (data) => {
    events.push(JSON.parse(String(data)));
    waiter?.();
  });
  function wait(predicate, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error('Event timeout: ' + JSON.stringify(events.slice(-3))));
      }, timeout);
      waiter = () => {
        const event = events.find(predicate);
        if (event) {
          clearTimeout(timer);
          waiter = null;
          resolve(event);
        }
      };
      waiter();
    });
  }
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await opened;
  const send = (event) => ws.send(JSON.stringify(event));
  let answer;
  let audio;
  let recognized;
  try {
    send({ type: 'start' });
    await wait((e) => e.type === 'audio' && e.audio?.length > 100);
    send({ type: 'text', text: 'Я впервые. Хочу на гончарный круг, сколько стоит?' });
    answer = await wait((e) => e.type === 'assistant' && /3200/.test(e.text));
    const quote = await wait((e) => e.type === 'quote' && e.quote?.total === 3200);
    assert.equal(quote.quote.programId, 'wheel');
    audio = await wait((e) => e.type === 'audio' && e.turnId === answer.turnId);
    assert.ok(audio.audio.length > 100);
    send({ type: 'interrupt' });
    const wav = fs.readFileSync(path.join(root, 'scripts/visitor-prices.wav'));
    let pcm;
    for (let offset = 12; offset + 8 < wav.length;) {
      const bytes = wav.readUInt32LE(offset + 4);
      if (wav.toString('ascii', offset, offset + 4) === 'data') {
        pcm = wav.subarray(offset + 8, offset + 8 + bytes);
        break;
      }
      offset += 8 + bytes + (bytes % 2);
    }
    assert.ok(pcm?.length);
    pcm = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 2)]);
    for (let offset = 0; offset < pcm.length; offset += 2560) {
      send({ type: 'pcm', audio: pcm.subarray(offset, offset + 2560).toString('base64') });
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    recognized = await wait((e) => e.type === 'transcript' && e.final && /стоим/.test(e.text));
  } finally {
    send({ type: 'stop' });
    ws.close();
  }
  const generated = await fetch('http://127.0.0.1:8150/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: 'qwen3',
      max_tokens: 16,
      temperature: 0,
      messages: [{ role: 'user', content: 'Ответь одним русским словом: привет' }],
      chat_template_kwargs: { enable_thinking: false },
    }),
  }).then((r) => r.json());
  assert.ok(generated.choices?.[0]?.message?.content?.length);
  const report = {
    root,
    health,
    mode: JSON.parse(
      fs.readFileSync(path.join(root, 'runtime/launch-mode.json'), 'utf8').replace(/^\uFEFF/, ''),
    ),
    greetingAudio: true,
    asr: recognized.text,
    quote: 3200,
    answer: answer.text,
    audioBytes: Buffer.from(audio.audio, 'base64').length,
    inference: generated.choices[0].message.content,
  };
  fs.writeFileSync(path.join(root, 'runtime/portable-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
