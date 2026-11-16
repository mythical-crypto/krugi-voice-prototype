function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/ё/g, 'е')
      .match(/[а-яa-z0-9]+/g) ?? []
  ).map((word) => (word.length >= 5 ? word.slice(0, 5) : word));
}

// AEC is the first protection; this catches recognizable playback left in the ASR stream.
// A single word never suppresses a visitor's short answer.
export function isPlaybackEcho(recognized: string, spoken: string): boolean {
  const input = tokens(recognized);
  const output = tokens(spoken);
  if (input.length < 4 || output.length < 4) return false;
  if (output.join(' ').includes(input.join(' '))) return true;
  let best = 0;
  for (let start = 0; start < output.length; start++) {
    const window = new Set(output.slice(start, start + input.length + 2));
    best = Math.max(best, input.filter((word) => window.has(word)).length / input.length);
  }
  return best >= 0.75;
}
