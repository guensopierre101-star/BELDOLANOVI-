/**
 * Low-latency raw PCM audio utilities for Gemini Live API
 * Input: 16kHz, 16-bit, mono, little-endian PCM ("audio/pcm;rate=16000")
 * Output: 24kHz, 16-bit, mono, little-endian PCM
 */

export function encodeFloat32ToBase64Pcm16(
  inputSamples: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): string {
  let samples = inputSamples;

  if (inputSampleRate !== targetSampleRate && inputSampleRate > 0) {
    const ratio = inputSampleRate / targetSampleRate;
    const newLength = Math.round(inputSamples.length / ratio);
    const resampled = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), inputSamples.length);
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += inputSamples[j];
        count++;
      }
      resampled[i] = count > 0 ? sum / count : inputSamples[Math.min(start, inputSamples.length - 1)] || 0;
    }
    samples = resampled;
  }

  const byteLength = samples.length * 2;
  const bytes = new Uint8Array(byteLength);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    bytes[i * 2] = int16 & 0xff;
    bytes[i * 2 + 1] = (int16 >> 8) & 0xff;
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }

  return window.btoa(binary);
}

export function decodeBase64Pcm16ToFloat32(base64: string): Float32Array {
  const binaryString = window.atob(base64);
  const sampleCount = Math.floor(binaryString.length / 2);
  const float32 = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const low = binaryString.charCodeAt(i * 2);
    const high = binaryString.charCodeAt(i * 2 + 1);
    let int16 = (high << 8) | low;
    if (int16 >= 0x8000) {
      int16 -= 0x10000;
    }
    float32[i] = int16 / 32768.0;
  }

  return float32;
}

export function calculateRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return Math.min(1, rms * 4.2);
}
