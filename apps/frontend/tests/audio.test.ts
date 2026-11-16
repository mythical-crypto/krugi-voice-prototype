import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

type Frame = { pcm: ArrayBuffer; rms: number };
type Processor = { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };

const source = readFileSync(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8');

for (const sampleRate of [44_100, 48_000]) {
  test(`worklet converts ${sampleRate} Hz to PCM16 16 kHz without output feedback`, () => {
    const frames: Frame[] = [];
    let ProcessorClass: (new () => Processor) | undefined;
    class ProcessorBase {
      port = { postMessage: (frame: Frame) => frames.push(frame) };
    }
    runInNewContext(source, {
      AudioWorkletProcessor: ProcessorBase,
      sampleRate,
      registerProcessor: (_name: string, constructor: new () => Processor) => {
        ProcessorClass = constructor;
      },
    });
    if (!ProcessorClass) throw new Error('Processor was not registered');
    const processor = new ProcessorClass();
    const input = new Float32Array(128).fill(0.25);
    const output = new Float32Array(128).fill(1);
    const iterations = Math.floor(sampleRate / 128);
    for (let i = 0; i < iterations; i++)
      expect(processor.process([[input]], [[output]])).toBe(true);
    expect(frames.length).toBe(12);
    expect(frames[0]!.pcm.byteLength).toBe(2560);
    expect(frames[0]!.rms).toBeCloseTo(0.25, 4);
    expect(new Int16Array(frames[0]!.pcm)[0]).toBe(8192);
    expect(output.every((value) => value === 0)).toBe(true);
  });
}
