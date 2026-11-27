class TickDetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;

    // Parámetros de detección ajustables desde la interfaz
    this.snrThreshold = 5.5;
    this.minIntervalS = 0.35;
    this.minDurationMs = 8.0;
    this.maxDurationMs = 52.0;
    this.minAbsFloor = 1e-6;

    // Ventanas deslizantes RMS: corta (2 ms) para localizar el inicio y larga (15 ms) para integrar energía
    this.winShort = Math.max(3, Math.round(0.002 * sr));
    this.winLong = Math.max(5, Math.round(0.015 * sr));
    this.sqShortBuf = new Float64Array(this.winShort);
    this.sqLongBuf = new Float64Array(this.winLong);
    this.idxShort = 0;
    this.idxLong = 0;
    this.sumShort = 0.0;
    this.sumLong = 0.0;

    // Anillo histórico de 140 ms para inspeccionar [-30 ms, +30 ms] alrededor de cada pulso
    this.ringLen = Math.ceil(0.140 * sr);
    this.bpRing = new Float32Array(this.ringLen);
    this.shortRing = new Float32Array(this.ringLen);

    // Estimación adaptativa del piso de ruido (mediana de los últimos 3 s muestreada cada 20 ms)
    this.floorStep = Math.max(1, Math.round(0.020 * sr));
    this.floorCap = 150;
    this.floorHist = new Float32Array(this.floorCap);
    this.floorScratch = new Float32Array(this.floorCap);
    this.floorWrite = 0;
    this.floorCount = 0;
    this.noiseFloor = 1e-4;

    // Referencia dinámica de amplitud de golpes recientes para rechazar roces débiles intermedios
    this.refCap = 10;
    this.refHist = new Float32Array(this.refCap);
    this.refScratch = new Float32Array(this.refCap);
    this.refWrite = 0;
    this.refCount = 0;
    this.refTickAmp = 0.0;

    // Estado de captura de eventos y telemetría de nivel
    this.globalSample = 0;
    this.lastAcceptedSample = -1e9;
    this.cooldownUntil = 0;
    this.inCapture = false;
    this.captureStartSample = 0;
    this.candPeakSample = 0;
    this.candPeakLong = 0;

    this.meterStep = Math.max(128, Math.round(0.040 * sr));
    this.nextMeterSample = this.meterStep;
    this.peakMeterSinceLast = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "config") {
        if (typeof msg.snrThreshold === "number") this.snrThreshold = msg.snrThreshold;
        if (typeof msg.minIntervalS === "number") this.minIntervalS = msg.minIntervalS;
        if (typeof msg.minDurationMs === "number") this.minDurationMs = msg.minDurationMs;
        if (typeof msg.maxDurationMs === "number") this.maxDurationMs = msg.maxDurationMs;
      } else if (msg.type === "reset") {
        this.lastAcceptedSample = -1e9;
        this.cooldownUntil = 0;
        this.inCapture = false;
        this.floorCount = 0;
        this.floorWrite = 0;
        this.refCount = 0;
        this.refWrite = 0;
        this.refTickAmp = 0.0;
      }
    };
  }

  updateRefTickAmp(amp) {
    this.refHist[this.refWrite] = amp;
    this.refWrite = (this.refWrite + 1) % this.refCap;
    if (this.refCount < this.refCap) {
      this.refCount += 1;
    }
    const n = this.refCount;
    for (let i = 0; i < n; i++) {
      this.refScratch[i] = this.refHist[i];
    }
    const sub = this.refScratch.subarray(0, n);
    sub.sort();
    this.refTickAmp = sub[Math.floor(n * 0.5)];
  }

  updateNoiseFloor(envLong) {
    this.floorHist[this.floorWrite] = envLong;
    this.floorWrite = (this.floorWrite + 1) % this.floorCap;
    if (this.floorCount < this.floorCap) {
      this.floorCount += 1;
    }
    const n = this.floorCount;
    for (let i = 0; i < n; i++) {
      this.floorScratch[i] = this.floorHist[i];
    }
    const sub = this.floorScratch.subarray(0, n);
    sub.sort();
    this.noiseFloor = sub[Math.floor(n * 0.5)];
  }

  recomputeSums() {
    let sShort = 0.0;
    for (let i = 0; i < this.winShort; i++) sShort += this.sqShortBuf[i];
    this.sumShort = sShort;

    let sLong = 0.0;
    for (let i = 0; i < this.winLong; i++) sLong += this.sqLongBuf[i];
    this.sumLong = sLong;
  }

  evaluateCandidate() {
    const sr = this.sr;
    const halfWin = Math.round(0.030 * sr);
    const minAvailable = Math.max(0, this.globalSample - this.ringLen + 2);
    const w0 = Math.max(minAvailable, this.candPeakSample - halfWin);
    const w1 = Math.min(this.globalSample, this.candPeakSample + halfWin);

    let localMaxBp = 0.0;
    let localMaxShort = -1.0;
    let pkSample = this.candPeakSample;

    for (let k = w0; k <= w1; k++) {
      const idx = k % this.ringLen;
      const abp = Math.abs(this.bpRing[idx]);
      if (abp > localMaxBp) localMaxBp = abp;
      const es = this.shortRing[idx];
      if (es > localMaxShort) {
        localMaxShort = es;
        pkSample = k;
      }
    }

    const effFloor = Math.max(this.minAbsFloor, this.noiseFloor);
    const ampThresh = Math.max(0.15 * localMaxBp, 4.0 * effFloor);
    let firstAbove = -1;
    let lastAbove = -1;
    for (let k = w0; k <= w1; k++) {
      if (Math.abs(this.bpRing[k % this.ringLen]) > ampThresh) {
        if (firstAbove < 0) firstAbove = k;
        lastAbove = k;
      }
    }

    const durationMs = firstAbove >= 0 ? ((lastAbove - firstAbove) * 1000.0) / sr : 0.0;
    const snr = this.candPeakLong / effFloor;

    if (durationMs < this.minDurationMs || durationMs > this.maxDurationMs) {
      this.inCapture = false;
      this.cooldownUntil = pkSample + Math.round(0.035 * sr);
      this.port.postMessage({
        type: "rejected",
        timeS: pkSample / sr,
        durationMs,
        snr
      });
      return;
    }

    // Refinamiento parabólico del pico sobre la envolvente corta
    let pkRefined = pkSample;
    if (pkSample > w0 && pkSample < w1) {
      const y0 = this.shortRing[(pkSample - 1) % this.ringLen];
      const y1 = this.shortRing[pkSample % this.ringLen];
      const y2 = this.shortRing[(pkSample + 1) % this.ringLen];
      const denom = y0 - 2.0 * y1 + y2;
      if (Math.abs(denom) > 1e-15) {
        const delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
        pkRefined = pkSample + delta;
      }
    }

    // Inicio del golpe (onset): primer cruce del 30 % de la envolvente corta antes del pico
    const onsetThresh = 0.30 * localMaxShort;
    let onsetRefined = pkSample;
    for (let k = w0; k <= pkSample; k++) {
      const val = this.shortRing[k % this.ringLen];
      if (val >= onsetThresh) {
        if (k > w0) {
          const prev = this.shortRing[(k - 1) % this.ringLen];
          const frac = val > prev ? (onsetThresh - prev) / (val - prev) : 0.0;
          onsetRefined = k - 1 + Math.max(0.0, Math.min(1.0, frac));
        } else {
          onsetRefined = k;
        }
        break;
      }
    }

    const minIntervalSamples = Math.round(this.minIntervalS * sr);
    if (onsetRefined - this.lastAcceptedSample < minIntervalSamples * 0.85) {
      this.inCapture = false;
      this.cooldownUntil = pkSample + Math.round(0.035 * sr);
      return;
    }

    this.lastAcceptedSample = onsetRefined;
    this.inCapture = false;
    this.cooldownUntil = pkSample + Math.round(0.050 * sr);
    this.updateRefTickAmp(this.candPeakLong);

    this.port.postMessage({
      type: "tick",
      onsetS: onsetRefined / sr,
      peakS: pkRefined / sr,
      durationMs,
      amplitude: this.candPeakLong,
      noiseFloor: effFloor,
      snr
    });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    const inChan = input[0];
    const out = outputs[0];
    if (out && out.length > 0 && out[0]) {
      out[0].set(inChan);
    }

    const sr = this.sr;
    const minIntervalSamples = Math.round(this.minIntervalS * sr);
    const postWait = Math.round(0.032 * sr);
    const maxCaptureSpan = Math.round(0.085 * sr);

    for (let i = 0; i < inChan.length; i++) {
      const x = inChan[i];
      const sq = x * x;
      const s = this.globalSample;

      // Actualizar RMS corta (2 ms)
      this.sumShort += sq - this.sqShortBuf[this.idxShort];
      this.sqShortBuf[this.idxShort] = sq;
      this.idxShort = (this.idxShort + 1) % this.winShort;
      const envShort = Math.sqrt(Math.max(0.0, this.sumShort / this.winShort));

      // Actualizar RMS larga (15 ms)
      this.sumLong += sq - this.sqLongBuf[this.idxLong];
      this.sqLongBuf[this.idxLong] = sq;
      this.idxLong = (this.idxLong + 1) % this.winLong;
      const envLong = Math.sqrt(Math.max(0.0, this.sumLong / this.winLong));

      const ringIdx = s % this.ringLen;
      this.bpRing[ringIdx] = x;
      this.shortRing[ringIdx] = envShort;

      if (envLong > this.peakMeterSinceLast) {
        this.peakMeterSinceLast = envLong;
      }

      if (s % this.floorStep === 0) {
        this.updateNoiseFloor(envLong);
      }
      if (s > 0 && s % sr === 0) {
        this.recomputeSums();
      }

      if (this.lastAcceptedSample > 0 && s - this.lastAcceptedSample > Math.round(1.8 * sr)) {
        this.refTickAmp *= 0.99995;
      }

      const effFloor = Math.max(this.minAbsFloor, this.noiseFloor);
      const threshold = Math.max(effFloor * this.snrThreshold, this.refTickAmp * 0.33);

      if (!this.inCapture) {
        if (
          this.floorCount >= 12 &&
          envLong >= threshold &&
          s >= this.cooldownUntil &&
          s - this.lastAcceptedSample >= minIntervalSamples
        ) {
          this.inCapture = true;
          this.captureStartSample = s;
          this.candPeakSample = s;
          this.candPeakLong = envLong;
        }
      } else {
        if (envLong > this.candPeakLong && s - this.captureStartSample <= maxCaptureSpan) {
          this.candPeakLong = envLong;
          this.candPeakSample = s;
        }
        if (s - this.candPeakSample >= postWait) {
          this.evaluateCandidate();
        }
      }

      if (s >= this.nextMeterSample) {
        this.port.postMessage({
          type: "meter",
          envLong: this.peakMeterSinceLast,
          noiseFloor: effFloor,
          threshold
        });
        this.peakMeterSinceLast = 0;
        this.nextMeterSample = s + this.meterStep;
      }

      this.globalSample = s + 1;
    }

    return true;
  }
}

registerProcessor("tick-detector-processor", TickDetectorProcessor);
