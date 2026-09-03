/**
 * Raw PCM to a playable WAV file.
 *
 * WHY THIS EXISTS AT ALL. Every TTS provider worth using returns headerless PCM — Gemini
 * hands back `audio/L16;codec=pcm;rate=24000`, Sarvam's Bulbul the same at 22050 — and a
 * `.wav` file is that PCM behind a 44-byte RIFF header. Writing the bytes straight to disk
 * produces a file every player refuses, which reads as "the API returned nothing" and sends
 * you debugging the wrong layer.
 *
 * Deliberately not a dependency. The header is four integers and three magic strings; a
 * package for it would be a supply-chain edge bought for forty lines.
 */

export interface PcmFormat {
  /** Samples per second. Gemini returns 24000, Sarvam 22050. */
  readonly sampleRate: number;
  /** 1 for mono. Every provider here returns mono. */
  readonly channels: number;
  /** Bits per sample. 16 for signed little-endian PCM, which is what all of them send. */
  readonly bitsPerSample: number;
}

export const GEMINI_PCM: PcmFormat = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };
export const SARVAM_PCM: PcmFormat = { sampleRate: 22_050, channels: 1, bitsPerSample: 16 };

/**
 * Wrap PCM samples in a canonical 44-byte RIFF/WAVE header.
 *
 * The format is fully determined by the three numbers above, so a mismatch between the
 * declared rate and the actual samples does not fail — it plays at the wrong pitch. That is
 * why the constants live beside the provider that produces them rather than being passed in
 * by a caller who would have to look them up.
 */
export function pcmToWav(pcm: Uint8Array, format: PcmFormat): Uint8Array {
  if (format.channels < 1) throw new Error('channels must be at least 1');
  if (format.sampleRate < 1) throw new Error('sampleRate must be positive');
  if (format.bitsPerSample % 8 !== 0) {
    throw new Error(`bitsPerSample must be a multiple of 8, got ${format.bitsPerSample}`);
  }

  const bytesPerSample = format.bitsPerSample / 8;
  const blockAlign = format.channels * bytesPerSample;
  const byteRate = format.sampleRate * blockAlign;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  // Everything after this field. `pcm.length + 36`, not + 44: the field excludes itself and
  // the four bytes of "RIFF" before it.
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');

  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk is 16 bytes
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);

  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);

  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/** Duration in seconds, for reporting what was produced without decoding it. */
export function durationSeconds(pcmBytes: number, format: PcmFormat): number {
  const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  return bytesPerSecond === 0 ? 0 : pcmBytes / bytesPerSecond;
}
