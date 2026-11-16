import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
export class VoiceWorker extends EventEmitter {
  ready = false;
  private process: ChildProcessWithoutNullStreams | null = null;
  constructor(readonly root: string) {
    super();
  }
  start() {
    const portablePython = join(this.root, 'tools/python/runtime/python.exe');
    this.process = spawn(
      existsSync(portablePython)
        ? portablePython
        : join(this.root, 'tools/python/venv/Scripts/python.exe'),
      ['-E', '-s', '-X', 'utf8', '-u', join(this.root, 'apps/voice/worker.py')],
      {
        cwd: this.root,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HOME: join(this.root, 'runtime/cache/huggingface'),
          PYTHONPYCACHEPREFIX: join(this.root, 'runtime/cache/pycache'),
        },
      },
    );
    const log = createWriteStream(join(this.root, 'runtime/logs/voice.log'), { flags: 'a' });
    this.process.stderr.pipe(log);
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => {
      try {
        if (line.length > 2_000_000) throw new Error('Oversized voice message');
        const event = JSON.parse(line);
        if (event.type === 'ready') this.ready = true;
        this.emit('message', event);
      } catch {
        this.emit('failure', 'Ошибка протокола голосовой модели');
      }
    });
    this.process.on('error', () => {
      this.ready = false;
      this.emit('failure', 'Голосовой процесс не запущен. Выполните setup.ps1.');
    });
    this.process.on('exit', () => {
      this.ready = false;
      log.end();
      this.emit('failure', 'Голосовой процесс остановлен');
    });
  }
  send(event: Record<string, unknown>) {
    if (!this.process?.stdin.writable) throw new Error('Голосовая модель недоступна');
    if (this.process.stdin.writableLength > 1_000_000)
      throw new Error('Голосовой процесс перегружен');
    this.process.stdin.write(JSON.stringify(event) + '\n');
  }
  async close() {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    try {
      child.stdin.end(JSON.stringify({ type: 'shutdown' }) + '\n');
    } catch {
      /* already stopped */
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) child.kill();
  }
}
