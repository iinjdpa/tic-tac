const DEFAULTS = {
  windowSize: 12,
  snrThreshold: 5.5,
  lowHz: 2500,
  highHz: 9500,
  minDurationMs: 8,
  minIntervalMs: 350,
  monitorAudio: false
};

const state = {
  ...DEFAULTS,
  listening: false,
  swapParity: false,
  baseTicParity: 0,
  parityLocked: false,
  audioCtx: null,
  mediaStream: null,
  workletNode: null,
  filters: null,
  monitorGain: null,
  wakeLock: null,
  deferredInstallPrompt: null,
  processorBlobUrl: null,
  events: [],
  intervals: [],
  rejectedCount: 0,
  meterHistory: []
};

const MAX_METER_POINTS = 140;

const dom = {
  btnMic: document.getElementById("btn-mic"),
  btnMicLabel: document.getElementById("btn-mic-label"),
  btnReset: document.getElementById("btn-reset"),
  btnSwap: document.getElementById("btn-swap"),
  btnInstall: document.getElementById("btn-install"),
  btnDefaults: document.getElementById("btn-defaults"),
  fileInput: document.getElementById("file-input"),
  wakelockBadge: document.getElementById("wakelock-badge"),
  statusBanner: document.getElementById("status-banner"),
  gaugeNeedle: document.getElementById("gauge-needle"),
  beatBadge: document.getElementById("beat-badge"),
  metricBeatMs: document.getElementById("metric-beat-ms"),
  metricBeatPct: document.getElementById("metric-beat-pct"),
  metricTicTac: document.getElementById("metric-tictac"),
  metricTicTacStd: document.getElementById("metric-tictac-std"),
  metricTacTic: document.getElementById("metric-tactic"),
  metricTacTicStd: document.getElementById("metric-tactic-std"),
  metricBpm: document.getElementById("metric-bpm"),
  metricHalfPeriod: document.getElementById("metric-halfperiod"),
  metricJitter: document.getElementById("metric-jitter"),
  metricCounts: document.getElementById("metric-counts"),
  pulseIndicator: document.getElementById("pulse-indicator"),
  canvasEnvelope: document.getElementById("canvas-envelope"),
  canvasIntervals: document.getElementById("canvas-intervals"),
  selWindow: document.getElementById("sel-window"),
  rngSnr: document.getElementById("rng-snr"),
  valSnr: document.getElementById("val-snr"),
  rngLow: document.getElementById("rng-low"),
  valLow: document.getElementById("val-low"),
  rngHigh: document.getElementById("rng-high"),
  valHigh: document.getElementById("val-high"),
  rngMinDur: document.getElementById("rng-mindur"),
  valMinDur: document.getElementById("val-mindur"),
  rngMinInt: document.getElementById("rng-minint"),
  valMinInt: document.getElementById("val-minint"),
  chkMonitor: document.getElementById("chk-monitor"),
  eventsTbody: document.getElementById("events-tbody"),
  tooltipPopover: document.getElementById("tooltip-popover"),
  tooltipText: document.getElementById("tooltip-text"),
  tooltipClose: document.getElementById("tooltip-close")
};

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / arr.length);
}

function median(arr) {
  if (!arr.length) return 0;
  const copy = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(copy.length / 2);
  return copy.length % 2 !== 0 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}

function parityLabel(parity) {
  const effectiveTic = state.swapParity ? 1 - state.baseTicParity : state.baseTicParity;
  return parity === effectiveTic ? "TIC" : "TAC";
}

function setStatus(msg) {
  dom.statusBanner.textContent = msg;
}

function flashPulse(label, cssClass) {
  dom.pulseIndicator.textContent = label;
  dom.pulseIndicator.className = `pulse-pill has-tooltip ${cssClass}`;
}

async function loadWorkletModule(ctx) {
  try {
    await ctx.audioWorklet.addModule("./processor.js");
  } catch (_err) {
    if (!state.processorBlobUrl) {
      const resp = await fetch("./processor.js");
      const code = await resp.text();
      state.processorBlobUrl = URL.createObjectURL(
        new Blob([code], { type: "application/javascript" })
      );
    }
    await ctx.audioWorklet.addModule(state.processorBlobUrl);
  }
}

function buildFilterGraph(ctx, sourceNode, workletNode, monitorOn) {
  const nyquistSafe = ctx.sampleRate * 0.46;
  const hi = Math.min(state.highHz, nyquistSafe);
  const lo = Math.max(40, Math.min(state.lowHz, hi * 0.8));

  const hp1 = ctx.createBiquadFilter();
  hp1.type = "highpass";
  hp1.frequency.value = lo;
  hp1.Q.value = Math.SQRT1_2;

  const hp2 = ctx.createBiquadFilter();
  hp2.type = "highpass";
  hp2.frequency.value = lo;
  hp2.Q.value = Math.SQRT1_2;

  const lp1 = ctx.createBiquadFilter();
  lp1.type = "lowpass";
  lp1.frequency.value = hi;
  lp1.Q.value = Math.SQRT1_2;

  const lp2 = ctx.createBiquadFilter();
  lp2.type = "lowpass";
  lp2.frequency.value = hi;
  lp2.Q.value = Math.SQRT1_2;

  const monitorGain = ctx.createGain();
  monitorGain.gain.value = monitorOn ? 1.8 : 0.0;

  sourceNode.connect(hp1);
  hp1.connect(hp2);
  hp2.connect(lp1);
  lp1.connect(lp2);
  lp2.connect(workletNode);
  workletNode.connect(monitorGain);
  monitorGain.connect(ctx.destination);

  return { filters: { hp1, hp2, lp1, lp2 }, monitorGain };
}

function sendWorkletConfig(node) {
  if (!node) return;
  node.port.postMessage({
    type: "config",
    snrThreshold: state.snrThreshold,
    minIntervalS: state.minIntervalMs / 1000.0,
    minDurationMs: state.minDurationMs,
    maxDurationMs: 52.0
  });
}

function attachWorkletMessages(node, isOfflineBatch = false) {
  node.port.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === "meter") {
      state.meterHistory.push({
        env: msg.envLong,
        threshold: msg.threshold,
        floor: msg.noiseFloor
      });
      if (state.meterHistory.length > MAX_METER_POINTS) {
        state.meterHistory.shift();
      }
      if (!isOfflineBatch) {
        drawEnvelopeCanvas();
      }
    } else if (msg.type === "rejected") {
      state.rejectedCount += 1;
      if (!isOfflineBatch) {
        flashPulse(`Ruido (${msg.durationMs.toFixed(1)} ms)`, "noise");
        updateMetricsUI();
      }
    } else if (msg.type === "tick") {
      recordTick(msg, isOfflineBatch);
    }
  };
}

function recordTick(msg, deferRender = false) {
  const n = state.events.length;
  let parity = 0;
  let dtMs = null;
  let isConsecutive = false;

  if (n > 0) {
    const prev = state.events[n - 1];
    const rawDtMs = (msg.onsetS - prev.onsetS) * 1000.0;

    if (state.intervals.length >= 3) {
      const recentDts = state.intervals.slice(-12).map((x) => x.dtMs);
      const refMs = median(recentDts);
      const ratio = rawDtMs / (refMs || 1);

      if (ratio >= 0.55 && ratio <= 1.45) {
        parity = 1 - prev.parity;
        dtMs = rawDtMs;
        isConsecutive = true;
      } else if (ratio >= 1.60 && ratio <= 2.45) {
        // Se perdió exactamente un golpe intermedio: la paridad se mantiene
        parity = prev.parity;
        dtMs = rawDtMs;
        isConsecutive = false;
      } else {
        parity = 0;
        dtMs = null;
        isConsecutive = false;
      }
    } else if (rawDtMs >= state.minIntervalMs * 0.85 && rawDtMs <= 2500) {
      parity = 1 - prev.parity;
      dtMs = rawDtMs;
      isConsecutive = true;
    }
  }

  const ev = {
    index: n + 1,
    parity,
    onsetS: msg.onsetS,
    peakS: msg.peakS,
    durationMs: msg.durationMs,
    snr: msg.snr,
    dtMs: isConsecutive ? dtMs : null
  };
  state.events.push(ev);

  // Igual que en el analizador Python: asignar TIC a la rama con mayor resonancia mediana inicial
  if (!state.parityLocked && state.events.length >= 6) {
    const d0 = state.events.filter((x) => x.parity === 0).map((x) => x.durationMs);
    const d1 = state.events.filter((x) => x.parity === 1).map((x) => x.durationMs);
    state.baseTicParity = median(d0) >= median(d1) ? 0 : 1;
    state.parityLocked = true;
  }

  if (isConsecutive && dtMs !== null) {
    const prev = state.events[n - 1];
    state.intervals.push({
      fromParity: prev.parity,
      dtMs,
      onsetS: msg.onsetS
    });
  }

  if (!deferRender) {
    const kind = parityLabel(ev.parity);
    flashPulse(`${kind} · ${ev.durationMs.toFixed(0)} ms`, kind === "TIC" ? "tic" : "tac");
    updateMetricsUI();
    renderEventsTable();
    drawIntervalsCanvas();
  }
}

function getActiveWindowIntervals() {
  if (state.windowSize <= 0) {
    return state.intervals;
  }
  return state.intervals.slice(-state.windowSize);
}

function updateMetricsUI() {
  const totalHits = state.events.length;
  dom.metricCounts.textContent = `${totalHits} golpes · ${state.rejectedCount} ruidos filtrados`;

  const win = getActiveWindowIntervals();
  if (win.length < 2) {
    dom.metricBeatMs.textContent = "— ms";
    dom.metricBeatPct.textContent = "(— %)";
    dom.metricTicTac.textContent = "— ms";
    dom.metricTicTacStd.textContent = "σ: — ms · n=0";
    dom.metricTacTic.textContent = "— ms";
    dom.metricTacTicStd.textContent = "σ: — ms · n=0";
    dom.metricBpm.textContent = "— BPM";
    dom.metricHalfPeriod.textContent = "Semiperíodo: — ms";
    dom.metricJitter.textContent = "σ: — ms";
    dom.gaugeNeedle.style.left = "50%";
    dom.beatBadge.textContent = `Esperando al menos 4 golpes (${totalHits}/4)…`;
    dom.beatBadge.className = "beat-badge neutral has-tooltip";
    return;
  }

  const effectiveTic = state.swapParity ? 1 - state.baseTicParity : state.baseTicParity;
  const ticToTac = win.filter((x) => x.fromParity === effectiveTic).map((x) => x.dtMs);
  const tacToTic = win.filter((x) => x.fromParity !== effectiveTic).map((x) => x.dtMs);
  const allDts = win.map((x) => x.dtMs);

  const meanHalf = mean(allDts);
  const bpm = meanHalf > 0 ? 60000.0 / meanHalf : 0;

  dom.metricBpm.textContent = `${bpm.toFixed(2)} BPM`;
  dom.metricHalfPeriod.textContent = `Semiperíodo: ${meanHalf.toFixed(1)} ms`;

  if (ticToTac.length > 0) {
    dom.metricTicTac.textContent = `${mean(ticToTac).toFixed(1)} ms`;
    dom.metricTicTacStd.textContent = `σ: ${stdDev(ticToTac).toFixed(1)} ms · n=${ticToTac.length}`;
  }
  if (tacToTic.length > 0) {
    dom.metricTacTic.textContent = `${mean(tacToTic).toFixed(1)} ms`;
    dom.metricTacTicStd.textContent = `σ: ${stdDev(tacToTic).toFixed(1)} ms · n=${tacToTic.length}`;
  }

  if (ticToTac.length > 0 && tacToTic.length > 0) {
    const m1 = mean(ticToTac);
    const m2 = mean(tacToTic);
    const s1 = stdDev(ticToTac);
    const s2 = stdDev(tacToTic);
    const pooledJitter = Math.sqrt(0.5 * (s1 * s1 + s2 * s2));
    dom.metricJitter.textContent = `σ pulso: ${pooledJitter.toFixed(1)} ms`;

    const signedBeatMs = (m1 - m2) * 0.5;
    const absBeatMs = Math.abs(signedBeatMs);
    const beatPct = meanHalf > 0 ? (absBeatMs / meanHalf) * 100.0 : 0;

    dom.metricBeatMs.textContent = `${absBeatMs.toFixed(2)} ms`;
    dom.metricBeatPct.textContent = `(${beatPct.toFixed(2)} %)`;

    // Mapear [-40 ms, +40 ms] -> [2%, 98%]
    const clamped = Math.max(-40, Math.min(40, signedBeatMs));
    const pctPos = 50 + (clamped / 40) * 48;
    dom.gaugeNeedle.style.left = `${pctPos.toFixed(2)}%`;

    if (absBeatMs <= 3.0 || beatPct <= 0.5) {
      dom.beatBadge.textContent = "EN COMPÁS · Reloj bien equilibrado";
      dom.beatBadge.className = "beat-badge good has-tooltip";
    } else if (absBeatMs <= 10.0 || beatPct <= 1.5) {
      const side = signedBeatMs > 0 ? "TIC→TAC más largo" : "TAC→TIC más largo";
      dom.beatBadge.textContent = `AJUSTE FINO · ${side}`;
      dom.beatBadge.className = "beat-badge warn has-tooltip";
    } else {
      const side = signedBeatMs > 0 ? "TIC→TAC domina" : "TAC→TIC domina";
      dom.beatBadge.textContent = `EN COJERA · Nivelar (${side})`;
      dom.beatBadge.className = "beat-badge bad has-tooltip";
    }
  }
}

function renderEventsTable() {
  if (!state.events.length) {
    dom.eventsTbody.innerHTML =
      '<tr><td colspan="5" class="empty-row">Aún no se han registrado golpes.</td></tr>';
    return;
  }

  const recent = state.events.slice(-40).reverse();
  const rows = recent.map((ev) => {
    const kind = parityLabel(ev.parity);
    const cls = kind === "TIC" ? "row-tic" : "row-tac";
    const dtText = ev.dtMs !== null ? ev.dtMs.toFixed(1) : "—";
    return `<tr>
      <td>${ev.index}</td>
      <td class="${cls}">${kind}</td>
      <td>${ev.onsetS.toFixed(3)}</td>
      <td>${dtText}</td>
      <td>${ev.durationMs.toFixed(1)}</td>
    </tr>`;
  });
  dom.eventsTbody.innerHTML = rows.join("");
}

function prepareCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(200, Math.round(rect.width * dpr));
  const h = Math.max(60, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width || 300, height: rect.height || 100 };
}

function drawEnvelopeCanvas() {
  const { ctx, width, height } = prepareCanvas(dom.canvasEnvelope);
  ctx.clearRect(0, 0, width, height);

  const hist = state.meterHistory;
  if (!hist.length) {
    ctx.fillStyle = "#64748b";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Sin señal activa", width / 2, height / 2 + 4);
    return;
  }

  let maxVal = 1e-4;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].env > maxVal) maxVal = hist[i].env;
    if (hist[i].threshold * 1.35 > maxVal) maxVal = hist[i].threshold * 1.35;
  }

  const padY = 8;
  const usableH = height - padY * 2;
  const stepX = width / Math.max(1, MAX_METER_POINTS - 1);

  // Relleno de envolvente
  ctx.beginPath();
  for (let i = 0; i < hist.length; i++) {
    const x = i * stepX;
    const y = height - padY - Math.min(1, hist[i].env / maxVal) * usableH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.lineTo((hist.length - 1) * stepX, height - padY);
  ctx.lineTo(0, height - padY);
  ctx.closePath();
  ctx.fillStyle = "rgba(56, 189, 248, 0.16)";
  ctx.fill();

  // Línea de umbral dinámico SNR
  ctx.beginPath();
  ctx.setLineDash([5, 4]);
  for (let i = 0; i < hist.length; i++) {
    const x = i * stepX;
    const y = height - padY - Math.min(1, hist[i].threshold / maxVal) * usableH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawIntervalsCanvas() {
  const { ctx, width, height } = prepareCanvas(dom.canvasIntervals);
  ctx.clearRect(0, 0, width, height);

  const recent = state.intervals.slice(-30);
  if (recent.length < 2) {
    ctx.fillStyle = "#64748b";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Los intervalos TIC→TAC y TAC→TIC aparecerán aquí", width / 2, height / 2 + 4);
    return;
  }

  const dts = recent.map((x) => x.dtMs);
  const centerMs = mean(dts);
  let maxDev = 20;
  for (let i = 0; i < dts.length; i++) {
    const dev = Math.abs(dts[i] - centerMs);
    if (dev * 1.25 > maxDev) maxDev = dev * 1.25;
  }

  const padL = 44;
  const padR = 12;
  const padY = 14;
  const plotW = Math.max(40, width - padL - padR);
  const plotH = Math.max(40, height - padY * 2);
  const midY = padY + plotH / 2;

  // Franja verde ±3 ms alrededor del ideal
  const greenHalfPx = Math.min(plotH / 2, (3.0 / maxDev) * (plotH / 2));
  ctx.fillStyle = "rgba(34, 197, 94, 0.12)";
  ctx.fillRect(padL, midY - greenHalfPx, plotW, greenHalfPx * 2);

  // Línea central ideal
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(padL, midY);
  ctx.lineTo(padL + plotW, midY);
  ctx.strokeStyle = "rgba(241, 245, 249, 0.65)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.setLineDash([]);

  // Etiquetas eje Y
  ctx.fillStyle = "#94a3b8";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${(centerMs + maxDev).toFixed(0)}`, padL - 5, padY + 4);
  ctx.fillText(`${centerMs.toFixed(0)}`, padL - 5, midY + 3);
  ctx.fillText(`${(centerMs - maxDev).toFixed(0)}`, padL - 5, padY + plotH);

  const effectiveTic = state.swapParity ? 1 - state.baseTicParity : state.baseTicParity;
  const stepX = recent.length > 1 ? plotW / (recent.length - 1) : 0;

  // Conectar ramas del mismo tipo con líneas suaves
  for (const targetTic of [true, false]) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < recent.length; i++) {
      const isTic = recent[i].fromParity === effectiveTic;
      if (isTic !== targetTic) continue;
      const x = padL + i * stepX;
      const y = midY - ((recent[i].dtMs - centerMs) / maxDev) * (plotH / 2);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = targetTic ? "rgba(34, 211, 238, 0.65)" : "rgba(245, 158, 11, 0.65)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // Puntos individuales
  for (let i = 0; i < recent.length; i++) {
    const isTic = recent[i].fromParity === effectiveTic;
    const x = padL + i * stepX;
    const y = midY - ((recent[i].dtMs - centerMs) / maxDev) * (plotH / 2);
    ctx.beginPath();
    ctx.arc(x, y, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = isTic ? "#22d3ee" : "#f59e0b";
    ctx.fill();
  }
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) {
    dom.wakelockBadge.textContent = "Pantalla normal";
    dom.wakelockBadge.className = "status-pill muted has-tooltip";
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    dom.wakelockBadge.textContent = "Pantalla activa";
    dom.wakelockBadge.className = "status-pill active has-tooltip";
    state.wakeLock.addEventListener("release", () => {
      if (!state.listening) {
        dom.wakelockBadge.textContent = "Pantalla normal";
        dom.wakelockBadge.className = "status-pill muted has-tooltip";
      }
    });
  } catch (_err) {
    dom.wakelockBadge.textContent = "Ahorro energía";
    dom.wakelockBadge.className = "status-pill muted has-tooltip";
  }
}

async function releaseWakeLock() {
  if (state.wakeLock) {
    try {
      await state.wakeLock.release();
    } catch (_err) {
      // Ignorar si ya fue liberado por el sistema
    }
    state.wakeLock = null;
  }
  dom.wakelockBadge.textContent = "Pantalla normal";
  dom.wakelockBadge.className = "status-pill muted has-tooltip";
}

async function startMicrophone() {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus(
      "El navegador requiere HTTPS o localhost para abrir el micrófono. Ábrela desde GitHub Pages o como app instalada."
    );
    return;
  }

  try {
    setStatus("Solicitando permiso del micrófono…");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false },
          channelCount: { ideal: 1 }
        },
        video: false
      });
    } catch (_constraintErr) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    await loadWorkletModule(ctx);
    const workletNode = new AudioWorkletNode(ctx, "tick-detector-processor");
    const micSource = ctx.createMediaStreamSource(stream);
    const { filters, monitorGain } = buildFilterGraph(ctx, micSource, workletNode, state.monitorAudio);

    state.audioCtx = ctx;
    state.mediaStream = stream;
    state.workletNode = workletNode;
    state.filters = filters;
    state.monitorGain = monitorGain;
    state.listening = true;

    attachWorkletMessages(workletNode, false);
    sendWorkletConfig(workletNode);
    await acquireWakeLock();

    dom.btnMic.classList.add("listening");
    dom.btnMicLabel.textContent = "Detener micrófono";
    setStatus(
      `Escuchando en vivo a ${ctx.sampleRate} Hz (banda ${state.lowHz}–${state.highHz} Hz, sin supresión de voz).`
    );
  } catch (err) {
    await stopMicrophone();
    setStatus(`No se pudo acceder al micrófono: ${err.message || err}`);
  }
}

async function stopMicrophone() {
  state.listening = false;
  if (state.workletNode) {
    try {
      state.workletNode.disconnect();
    } catch (_e) {}
    state.workletNode = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }
  if (state.audioCtx) {
    try {
      await state.audioCtx.close();
    } catch (_e) {}
    state.audioCtx = null;
  }
  state.filters = null;
  state.monitorGain = null;
  await releaseWakeLock();

  dom.btnMic.classList.remove("listening");
  dom.btnMicLabel.textContent = "Iniciar micrófono";
}

function resetMeasurements(announce = true) {
  state.events = [];
  state.intervals = [];
  state.rejectedCount = 0;
  state.meterHistory = [];
  state.parityLocked = false;
  state.baseTicParity = 0;

  if (state.workletNode) {
    state.workletNode.port.postMessage({ type: "reset" });
  }

  flashPulse("Sin pulso", "");
  updateMetricsUI();
  renderEventsTable();
  drawEnvelopeCanvas();
  drawIntervalsCanvas();

  if (announce) {
    setStatus(
      state.listening
        ? "Ventana reiniciada. Midiendo nuevos golpes tras el ajuste…"
        : "Mediciones reiniciadas."
    );
  }
}

async function analyzeAudioFile(file) {
  if (!file) return;
  if (state.listening) {
    await stopMicrophone();
  }
  resetMeasurements(false);
  setStatus(`Decodificando «${file.name}»…`);

  try {
    const rawBuf = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const decodeCtx = new AudioCtx();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(rawBuf);
    } finally {
      await decodeCtx.close();
    }

    const sr = decoded.sampleRate;
    const len = decoded.length;
    const mono = new Float32Array(len);
    const nCh = decoded.numberOfChannels;
    for (let ch = 0; ch < nCh; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        mono[i] += data[i] / nCh;
      }
    }

    let peak = 0;
    for (let i = 0; i < len; i++) {
      const a = Math.abs(mono[i]);
      if (a > peak) peak = a;
    }
    if (peak > 0) {
      for (let i = 0; i < len; i++) mono[i] /= peak;
    }

    setStatus(`Filtrando y detectando tic-tac en «${file.name}» (${(len / sr).toFixed(1)} s @ ${sr} Hz)…`);
    const padSamples = Math.round(0.050 * sr);
    const totalLen = len + padSamples;
    const offlineCtx = new OfflineAudioContext(1, totalLen, sr);
    await loadWorkletModule(offlineCtx);

    const audioBuf = offlineCtx.createBuffer(1, totalLen, sr);
    audioBuf.getChannelData(0).set(mono);

    const bufSource = offlineCtx.createBufferSource();
    bufSource.buffer = audioBuf;

    const workletNode = new AudioWorkletNode(offlineCtx, "tick-detector-processor");
    buildFilterGraph(offlineCtx, bufSource, workletNode, false);
    attachWorkletMessages(workletNode, true);
    sendWorkletConfig(workletNode);

    bufSource.start(0);
    await offlineCtx.startRendering();
    // Dar margen al hilo principal para drenar los mensajes postMessage del AudioWorklet
    await new Promise((resolve) => setTimeout(resolve, 60));

    updateMetricsUI();
    renderEventsTable();
    drawEnvelopeCanvas();
    drawIntervalsCanvas();

    if (state.events.length > 0) {
      const lastEv = state.events[state.events.length - 1];
      const kind = parityLabel(lastEv.parity);
      flashPulse(`${kind} · ${state.events.length} golpes`, kind === "TIC" ? "tic" : "tac");
    }
    setStatus(
      `Archivo «${file.name}» analizado: ${state.events.length} golpes válidos y ${state.rejectedCount} ruidos filtrados.`
    );
  } catch (err) {
    setStatus(`No se pudo decodificar «${file.name}» en el navegador: ${err.message || err}`);
  } finally {
    dom.fileInput.value = "";
  }
}

function applyLiveFilterSettings() {
  if (state.filters && state.audioCtx) {
    const nyquistSafe = state.audioCtx.sampleRate * 0.46;
    const hi = Math.min(state.highHz, nyquistSafe);
    const lo = Math.max(40, Math.min(state.lowHz, hi * 0.8));
    state.filters.hp1.frequency.value = lo;
    state.filters.hp2.frequency.value = lo;
    state.filters.lp1.frequency.value = hi;
    state.filters.lp2.frequency.value = hi;
  }
  if (state.monitorGain) {
    state.monitorGain.gain.value = state.monitorAudio ? 1.8 : 0.0;
  }
  if (state.workletNode) {
    sendWorkletConfig(state.workletNode);
  }
}

function syncSettingsLabels() {
  dom.selWindow.value = String(state.windowSize);
  dom.rngSnr.value = String(state.snrThreshold);
  dom.valSnr.textContent = `${state.snrThreshold.toFixed(1)}×`;
  dom.rngLow.value = String(state.lowHz);
  dom.valLow.textContent = `${state.lowHz} Hz`;
  dom.rngHigh.value = String(state.highHz);
  dom.valHigh.textContent = `${state.highHz} Hz`;
  dom.rngMinDur.value = String(state.minDurationMs);
  dom.valMinDur.textContent = `${state.minDurationMs} ms`;
  dom.rngMinInt.value = String(state.minIntervalMs);
  dom.valMinInt.textContent = `${state.minIntervalMs} ms`;
  dom.chkMonitor.checked = state.monitorAudio;
}

function initControls() {
  dom.btnMic.addEventListener("click", async () => {
    if (state.listening) {
      await stopMicrophone();
      setStatus("Micrófono detenido.");
    } else {
      await startMicrophone();
    }
  });

  dom.btnReset.addEventListener("click", () => {
    resetMeasurements(true);
  });

  dom.btnSwap.addEventListener("click", () => {
    state.swapParity = !state.swapParity;
    updateMetricsUI();
    renderEventsTable();
    drawIntervalsCanvas();
  });

  dom.fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) analyzeAudioFile(file);
  });

  dom.selWindow.addEventListener("change", () => {
    state.windowSize = Number(dom.selWindow.value);
    updateMetricsUI();
  });

  dom.rngSnr.addEventListener("input", () => {
    state.snrThreshold = Number(dom.rngSnr.value);
    dom.valSnr.textContent = `${state.snrThreshold.toFixed(1)}×`;
    applyLiveFilterSettings();
  });

  dom.rngLow.addEventListener("input", () => {
    state.lowHz = Number(dom.rngLow.value);
    if (state.lowHz >= state.highHz - 500) {
      state.lowHz = state.highHz - 500;
      dom.rngLow.value = String(state.lowHz);
    }
    dom.valLow.textContent = `${state.lowHz} Hz`;
    applyLiveFilterSettings();
  });

  dom.rngHigh.addEventListener("input", () => {
    state.highHz = Number(dom.rngHigh.value);
    if (state.highHz <= state.lowHz + 500) {
      state.highHz = state.lowHz + 500;
      dom.rngHigh.value = String(state.highHz);
    }
    dom.valHigh.textContent = `${state.highHz} Hz`;
    applyLiveFilterSettings();
  });

  dom.rngMinDur.addEventListener("input", () => {
    state.minDurationMs = Number(dom.rngMinDur.value);
    dom.valMinDur.textContent = `${state.minDurationMs} ms`;
    applyLiveFilterSettings();
  });

  dom.rngMinInt.addEventListener("input", () => {
    state.minIntervalMs = Number(dom.rngMinInt.value);
    dom.valMinInt.textContent = `${state.minIntervalMs} ms`;
    applyLiveFilterSettings();
  });

  dom.chkMonitor.addEventListener("change", () => {
    state.monitorAudio = dom.chkMonitor.checked;
    applyLiveFilterSettings();
  });

  dom.btnDefaults.addEventListener("click", () => {
    Object.assign(state, DEFAULTS);
    syncSettingsLabels();
    applyLiveFilterSettings();
    updateMetricsUI();
    setStatus("Ajustes del filtro restaurados a los valores óptimos.");
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.listening && !state.wakeLock) {
      await acquireWakeLock();
    }
  });

  window.addEventListener("resize", () => {
    drawEnvelopeCanvas();
    drawIntervalsCanvas();
  });
}

function showTooltip(text) {
  if (!text) return;
  dom.tooltipText.textContent = text;
  dom.tooltipPopover.classList.remove("hidden");
}

function hideTooltip() {
  dom.tooltipPopover.classList.add("hidden");
}

function initTooltips() {
  document.querySelectorAll(".tip-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = btn.dataset.tooltip || btn.getAttribute("title");
      showTooltip(text);
    });
  });

  // Soporte adicional para pulsación prolongada en pantallas táctiles sobre cualquier elemento con data-tooltip
  let pressTimer = null;
  document.querySelectorAll(".has-tooltip").forEach((el) => {
    el.addEventListener(
      "touchstart",
      () => {
        const text = el.dataset.tooltip || el.getAttribute("title");
        if (!text) return;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => showTooltip(text), 520);
      },
      { passive: true }
    );
    el.addEventListener("touchend", () => clearTimeout(pressTimer), { passive: true });
    el.addEventListener("touchmove", () => clearTimeout(pressTimer), { passive: true });
  });

  dom.tooltipClose.addEventListener("click", hideTooltip);
  document.addEventListener("click", (e) => {
    if (!dom.tooltipPopover.classList.contains("hidden") && !dom.tooltipPopover.contains(e.target)) {
      hideTooltip();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTooltip();
  });
}

function initPwaInstallAndSw() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    dom.btnInstall.classList.remove("hidden");
  });

  dom.btnInstall.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    const choice = await state.deferredInstallPrompt.userChoice;
    if (choice && choice.outcome === "accepted") {
      dom.btnInstall.classList.add("hidden");
      setStatus("Aplicación instalada en el dispositivo. Ya funciona sin conexión.");
    }
    state.deferredInstallPrompt = null;
  });

  window.addEventListener("appinstalled", () => {
    dom.btnInstall.classList.add("hidden");
    state.deferredInstallPrompt = null;
  });

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
}

syncSettingsLabels();
initControls();
initTooltips();
initPwaInstallAndSw();
drawEnvelopeCanvas();
drawIntervalsCanvas();
