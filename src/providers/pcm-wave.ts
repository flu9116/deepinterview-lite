export function pcmWave(pcm: Buffer, sampleRate: number, leadInMs = 0): Buffer {
  if (!pcm.length || pcm.length % 2 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    throw new Error('Invalid mono PCM');
  }
  const leadIn = Buffer.alloc(Math.round(sampleRate * leadInMs / 1000) * 2);
  const payloadBytes = pcm.length + leadIn.length;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + payloadBytes, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(payloadBytes, 40);
  return Buffer.concat([header, leadIn, pcm]);
}
