const DEFAULT_MIN_HZ = 0.7;
const DEFAULT_MAX_HZ = 3.0;

export function resample(tsMs, rgb, fs = 30) {
  if (tsMs.length !== rgb.length || tsMs.length < 2 || !(fs > 0)) {
    throw new RangeError("Expected at least two timestamps and matching RGB samples");
  }
  for (let i = 1; i < tsMs.length; i += 1) {
    if (!(tsMs[i] > tsMs[i - 1])) {
      throw new RangeError("Timestamps must be strictly increasing");
    }
  }

  const stepMs = 1000 / fs;
  const count = Math.floor((tsMs.at(-1) - tsMs[0]) / stepMs) + 1;
  const result = new Array(count);
  let source = 0;

  for (let i = 0; i < count; i += 1) {
    const time = tsMs[0] + i * stepMs;
    while (source + 1 < tsMs.length - 1 && tsMs[source + 1] < time) source += 1;
    const span = tsMs[source + 1] - tsMs[source];
    const fraction = Math.max(0, Math.min(1, (time - tsMs[source]) / span));
    result[i] = rgb[source].map(
      (channel, index) => channel + fraction * (rgb[source + 1][index] - channel),
    );
  }
  return result;
}

export function pos(rgb, fs) {
  if (!(fs > 0) || rgb.length < 2) throw new RangeError("Expected RGB samples and a positive sample rate");

  const length = Math.max(2, Math.round(1.6 * fs));
  const hop = Math.max(1, Math.round(length / 2));
  const output = new Float64Array(rgb.length);
  const weights = new Uint32Array(rgb.length);

  for (let start = 0; start < rgb.length; start += hop) {
    const end = Math.min(rgb.length, start + length);
    const size = end - start;
    if (size < 2) break;

    const means = [0, 0, 0];
    for (let i = start; i < end; i += 1) {
      means[0] += rgb[i][0];
      means[1] += rgb[i][1];
      means[2] += rgb[i][2];
    }
    for (let channel = 0; channel < 3; channel += 1) {
      means[channel] /= size;
    }
    if (means.some((mean) => !Number.isFinite(mean) || Math.abs(mean) < 1e-12)) continue;

    const s1 = new Float64Array(size);
    const s2 = new Float64Array(size);
    let mean1 = 0;
    let mean2 = 0;
    for (let i = 0; i < size; i += 1) {
      const [red, green, blue] = rgb[start + i];
      const r = red / means[0];
      const g = green / means[1];
      const b = blue / means[2];
      s1[i] = g - b;
      s2[i] = -2 * r + g + b;
      mean1 += s1[i];
      mean2 += s2[i];
    }
    mean1 /= size;
    mean2 /= size;

    let variance1 = 0;
    let variance2 = 0;
    for (let i = 0; i < size; i += 1) {
      variance1 += (s1[i] - mean1) ** 2;
      variance2 += (s2[i] - mean2) ** 2;
    }
    const std2 = Math.sqrt(variance2 / size);
    const ratio = std2 > 1e-12 ? Math.sqrt(variance1 / size) / std2 : 0;
    let pulseMean = 0;
    const pulse = new Float64Array(size);
    for (let i = 0; i < size; i += 1) {
      pulse[i] = s1[i] + ratio * s2[i];
      pulseMean += pulse[i];
    }
    pulseMean /= size;
    for (let i = 0; i < size; i += 1) {
      output[start + i] += pulse[i] - pulseMean;
      weights[start + i] += 1;
    }
  }

  for (let i = 0; i < output.length; i += 1) {
    if (weights[i] > 0) output[i] /= weights[i];
  }
  return output;
}

function detrend(signal) {
  const size = signal.length;
  let meanY = 0;
  for (const value of signal) meanY += value;
  meanY /= size;
  const meanX = (size - 1) / 2;
  let covariance = 0;
  let varianceX = 0;
  for (let i = 0; i < size; i += 1) {
    covariance += (i - meanX) * (signal[i] - meanY);
    varianceX += (i - meanX) ** 2;
  }
  const slope = varianceX > 0 ? covariance / varianceX : 0;
  return Float64Array.from(
    signal,
    (value, index) => value - (meanY + slope * (index - meanX)),
  );
}

function fft(real, imaginary) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }

  for (let width = 2; width <= size; width <<= 1) {
    const angle = (-2 * Math.PI) / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += width) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      const half = width >> 1;
      for (let j = 0; j < half; j += 1) {
        const even = offset + j;
        const odd = even + half;
        const productReal =
          twiddleReal * real[odd] - twiddleImaginary * imaginary[odd];
        const productImaginary =
          twiddleReal * imaginary[odd] + twiddleImaginary * real[odd];
        real[odd] = real[even] - productReal;
        imaginary[odd] = imaginary[even] - productImaginary;
        real[even] += productReal;
        imaginary[even] += productImaginary;
        const nextReal =
          twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary =
          twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

export function estimateBpm(signal, fs, { minHz = DEFAULT_MIN_HZ, maxHz = DEFAULT_MAX_HZ } = {}) {
  if (signal.length < 2 || !(fs > 0) || !(maxHz > minHz)) {
    throw new RangeError("Expected a signal, positive sample rate, and a valid frequency band");
  }
  const filtered = detrend(signal);
  let size = 8192;
  while (size < signal.length) size <<= 1;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  const denominator = Math.max(1, signal.length - 1);
  for (let i = 0; i < signal.length; i += 1) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denominator));
    real[i] = filtered[i] * hann;
  }
  fft(real, imaginary);

  const binRate = fs / size;
  const firstBin = Math.max(1, Math.ceil(minHz / binRate));
  const lastBin = Math.min(Math.floor(size / 2), Math.floor(maxHz / binRate));
  if (firstBin > lastBin) return { bpm: NaN, snr: -Infinity };
  const powerAt = (bin) => real[bin] ** 2 + imaginary[bin] ** 2;

  let peakBin = firstBin;
  for (let bin = firstBin + 1; bin <= lastBin; bin += 1) {
    if (powerAt(bin) > powerAt(peakBin)) peakBin = bin;
  }

  const left = Math.log(Math.max(powerAt(peakBin - 1), 1e-300));
  const center = Math.log(Math.max(powerAt(peakBin), 1e-300));
  const right = Math.log(Math.max(powerAt(peakBin + 1), 1e-300));
  const curvature = left - 2 * center + right;
  const offset = curvature === 0 ? 0 : Math.max(-1, Math.min(1, 0.5 * (left - right) / curvature));
  const peakHz = (peakBin + offset) * binRate;
  const targets = [peakHz];
  if (2 * peakHz <= maxHz) targets.push(2 * peakHz);
  let signalPower = 0;
  let bandPower = 0;
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    const frequency = bin * binRate;
    const power = powerAt(bin);
    bandPower += power;
    if (targets.some((target) => Math.abs(frequency - target) <= 0.1)) {
      signalPower += power;
    }
  }
  const noisePower = Math.max(bandPower - signalPower, 1e-300);
  const snr = 10 * Math.log10(Math.max(signalPower, 1e-300) / noisePower);
  return { bpm: peakHz * 60, snr };
}
