import { test, expect } from 'bun:test';
import { AudioSession } from '../src/audio';

async function withCaptureHarness(
  run: (harness: { grant(): void; expireOldTimeout(): void; stopped(): number }) => Promise<void>,
) {
  const keys = ['AudioContext', 'AudioWorkletNode', 'navigator', 'window'] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let grant!: (stream: MediaStream) => void;
  let stopped = 0;
  let oldTimeout: (() => void) | undefined;
  const track = {
    stop() {
      stopped++;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  class FakeContext {
    audioWorklet = { async addModule() {} };
    destination = {};
    async resume() {}
    async close() {}
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
  }
  class FakeWorklet {
    port = { onmessage: null };
    connect() {}
    disconnect() {}
  }
  const values = [
    FakeContext,
    FakeWorklet,
    {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<MediaStream>((resolve) => {
            grant = resolve;
          }),
      },
    },
    {
      setTimeout(callback: () => void) {
        oldTimeout = callback;
        return 1;
      },
      clearTimeout() {},
    },
  ];
  keys.forEach((key, index) =>
    Object.defineProperty(globalThis, key, { value: values[index], configurable: true }),
  );
  try {
    await run({
      grant: () => grant(stream),
      expireOldTimeout: () => oldTimeout?.(),
      stopped: () => stopped,
    });
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('permission may remain pending longer than the old timeout and still connect', async () => {
  await withCaptureHarness(async (harness) => {
    const audio = new AudioSession();
    let outcome = 'pending';
    const pending = audio
      .openMicrophone(() => {})
      .then(
        () => {
          outcome = 'connected';
        },
        () => {
          outcome = 'rejected';
        },
      );
    harness.expireOldTimeout();
    await new Promise((resolve) => setImmediate(resolve));
    expect(outcome).toBe('pending');
    harness.grant();
    await pending;
    expect(outcome).toBe('connected');
    audio.close();
    expect(harness.stopped()).toBe(1);
  });
});

test('cancelled capture stops a stream granted later', async () => {
  await withCaptureHarness(async (harness) => {
    const audio = new AudioSession();
    const pending = audio.openMicrophone(() => {});
    audio.close();
    harness.grant();
    await expect(pending).rejects.toThrow('заверш');
    expect(harness.stopped()).toBe(1);
  });
});
