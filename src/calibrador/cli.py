from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from pathlib import Path

import av
import numpy as np
import soundfile as sf
from scipy import signal


@dataclass
class TickEvent:
    index: int
    kind: str
    onset_s: float
    peak_s: float
    duration_ms: float
    amplitude: float
    dt_prev_s: float | None = None
    deviation_ms: float | None = None


def load_audio_mono(path: Path) -> tuple[np.ndarray, int, int]:
    """Decodifica un archivo de audio/video con PyAV tolerando paquetes dañados."""
    container = av.open(str(path))
    stream = container.streams.audio[0]
    sample_rate = int(stream.sample_rate)

    frames: list[np.ndarray] = []
    bad_packets = 0
    for packet in container.demux(stream):
        try:
            for frame in packet.decode():
                frames.append(frame.to_ndarray())
        except av.error.InvalidDataError:
            bad_packets += 1

    if not frames:
        raise RuntimeError(f"No se pudieron decodificar tramas de audio en {path}")

    audio = np.concatenate(frames, axis=1).astype(np.float64)
    if audio.ndim == 2:
        mono = audio.mean(axis=0)
    else:
        mono = audio

    peak = np.max(np.abs(mono))
    if peak > 0:
        mono = mono / peak

    return mono, sample_rate, bad_packets


def zero_phase_bandpass(
    samples: np.ndarray,
    sample_rate: int,
    low_hz: float = 2500.0,
    high_hz: float = 9500.0,
    order: int = 4,
) -> np.ndarray:
    """Filtro pasa-banda Butterworth de fase cero para no desplazar los instantes de tic-tac."""
    nyquist = sample_rate * 0.5
    hi = min(high_hz, nyquist * 0.95)
    lo = max(20.0, min(low_hz, hi * 0.8))
    sos = signal.butter(order, [lo, hi], btype="bandpass", fs=sample_rate, output="sos")
    return signal.sosfiltfilt(sos, samples)


def spectral_noise_gate(
    samples: np.ndarray,
    sample_rate: int,
    nperseg: int = 512,
    noverlap: int = 384,
    noise_percentile: float = 25.0,
    threshold_factor: float = 2.5,
    floor_gain: float = 0.02,
) -> np.ndarray:
    """Atenúa ruido estacionario estimando el piso espectral por percentiles bajos."""
    _, _, zxx = signal.stft(samples, fs=sample_rate, nperseg=nperseg, noverlap=noverlap)
    mag = np.abs(zxx)
    noise_profile = np.percentile(mag, noise_percentile, axis=1, keepdims=True)
    threshold = noise_profile * threshold_factor

    ratio = mag / (threshold + 1e-12)
    mask = np.clip((ratio - 0.5) / 1.0, floor_gain, 1.0)
    mask = signal.medfilt2d(mask, kernel_size=(3, 3))

    _, cleaned = signal.istft(zxx * mask, fs=sample_rate, nperseg=nperseg, noverlap=noverlap)
    if len(cleaned) >= len(samples):
        return cleaned[: len(samples)]
    return np.pad(cleaned, (0, len(samples) - len(cleaned)))


def compute_rms_envelope(samples: np.ndarray, sample_rate: int, window_ms: float) -> np.ndarray:
    win = max(3, int(round(window_ms * 1e-3 * sample_rate)))
    if win % 2 == 0:
        win += 1
    kernel = np.hanning(win)
    kernel /= kernel.sum()
    return np.sqrt(np.convolve(samples**2, kernel, mode="same"))


def refine_peak_parabolic(env: np.ndarray, idx: int) -> float:
    """Interpolación parabólica alrededor de un máximo discreto para precisión sub-muestra."""
    if idx <= 0 or idx >= len(env) - 1:
        return float(idx)
    y0, y1, y2 = env[idx - 1], env[idx], env[idx + 1]
    denom = y0 - 2.0 * y1 + y2
    if abs(denom) < 1e-15:
        return float(idx)
    delta = 0.5 * (y0 - y2) / denom
    delta = float(np.clip(delta, -0.5, 0.5))
    return float(idx) + delta


def detect_tick_tacks(
    bp_signal: np.ndarray,
    sample_rate: int,
    min_interval_s: float = 0.35,
    min_duration_ms: float = 8.0,
    snr_threshold: float = 5.5,
) -> list[TickEvent]:
    """Detecta golpes tic-tac discriminando clics espurios cortos mediante envolvente integrada."""
    env_long = compute_rms_envelope(bp_signal, sample_rate, window_ms=15.0)
    env_short = compute_rms_envelope(bp_signal, sample_rate, window_ms=2.0)

    noise_floor = float(np.median(env_long))
    if noise_floor <= 0:
        noise_floor = float(np.percentile(env_long, 25)) + 1e-12

    min_dist = int(min_interval_s * sample_rate)
    cand_peaks, _ = signal.find_peaks(
        env_long,
        height=noise_floor * snr_threshold,
        distance=min_dist,
        prominence=noise_floor * (snr_threshold * 0.65),
    )

    half_win = int(0.030 * sample_rate)
    events: list[TickEvent] = []

    for idx in cand_peaks:
        w0 = max(0, idx - half_win)
        w1 = min(len(bp_signal), idx + half_win)

        local_bp = np.abs(bp_signal[w0:w1])
        local_max_bp = float(np.max(local_bp))
        if local_max_bp <= 0:
            continue

        above = np.where(local_bp > 0.15 * local_max_bp)[0]
        duration_ms = (above[-1] - above[0]) * 1000.0 / sample_rate if len(above) > 0 else 0.0
        if duration_ms < min_duration_ms:
            continue

        local_short = env_short[w0:w1]
        pk_local = int(np.argmax(local_short))
        pk_refined = refine_peak_parabolic(local_short, pk_local)
        peak_s = (w0 + pk_refined) / sample_rate

        thresh = 0.30 * float(local_short[pk_local])
        pre = local_short[: pk_local + 1]
        cross = np.where(pre >= thresh)[0]
        onset_local = int(cross[0]) if len(cross) > 0 else pk_local
        onset_s = (w0 + onset_local) / sample_rate

        events.append(
            TickEvent(
                index=len(events) + 1,
                kind="",
                onset_s=onset_s,
                peak_s=peak_s,
                duration_ms=duration_ms,
                amplitude=float(env_long[idx]),
            )
        )

    if not events:
        return events

    even_durs = [e.duration_ms for i, e in enumerate(events) if i % 2 == 0]
    odd_durs = [e.duration_ms for i, e in enumerate(events) if i % 2 == 1]
    even_is_tic = (np.median(even_durs) if even_durs else 0.0) >= (np.median(odd_durs) if odd_durs else 0.0)

    for i, ev in enumerate(events):
        is_even = i % 2 == 0
        ev.kind = "TIC" if (is_even == even_is_tic) else "TAC"
        if i > 0:
            ev.dt_prev_s = ev.onset_s - events[i - 1].onset_s

    dts = [e.dt_prev_s for e in events if e.dt_prev_s is not None]
    if dts:
        ideal_half_period = float(np.mean(dts))
        for ev in events:
            if ev.dt_prev_s is not None:
                ev.deviation_ms = (ev.dt_prev_s - ideal_half_period) * 1000.0

    return events


def apply_temporal_gate(
    samples: np.ndarray,
    sample_rate: int,
    events: list[TickEvent],
    pre_ms: float = 15.0,
    post_ms: float = 55.0,
    fade_ms: float = 8.0,
    floor_gain: float = 0.0,
) -> np.ndarray:
    """Mantiene únicamente las ventanas alrededor de cada tic/tac real con rampas coseno suaves."""
    if not events:
        return samples.copy()

    n = len(samples)
    gate = np.full(n, floor_gain, dtype=np.float64)
    pre_s = int(round(pre_ms * 1e-3 * sample_rate))
    post_s = int(round(post_ms * 1e-3 * sample_rate))
    fade_s = max(1, int(round(fade_ms * 1e-3 * sample_rate)))

    for ev in events:
        center = int(round(ev.peak_s * sample_rate))
        start = max(0, center - pre_s)
        end = min(n, center + post_s)
        if end <= start:
            continue

        win = np.ones(end - start, dtype=np.float64)
        f_len = min(fade_s, (end - start) // 2)
        if f_len > 0:
            ramp = 0.5 * (1.0 - np.cos(np.pi * np.arange(f_len) / f_len))
            win[:f_len] = ramp
            win[-f_len:] = ramp[::-1]

        gate[start:end] = np.maximum(gate[start:end], floor_gain + (1.0 - floor_gain) * win)

    return samples * gate


def print_calibration_report(
    input_path: Path,
    sample_rate: int,
    duration_s: float,
    bad_packets: int,
    events: list[TickEvent],
) -> None:
    print("=" * 72)
    print(f"CALIBRACIÓN DE RELOJ DE PÉNDULO — {input_path}")
    print("=" * 72)
    print(f"Frecuencia de muestreo : {sample_rate} Hz")
    print(f"Duración               : {duration_s:.3f} s")
    if bad_packets:
        print(f"Paquetes corruptos     : {bad_packets} (omitidos sin pérdida de sincronía)")
    print(f"Eventos detectados     : {len(events)}")

    if len(events) < 3:
        print("No hay suficientes eventos tic-tac para calcular métricas de calibración.")
        return

    dts = np.array([e.dt_prev_s for e in events if e.dt_prev_s is not None], dtype=np.float64)
    tic_to_tac = np.array(
        [events[i].dt_prev_s for i in range(1, len(events)) if events[i - 1].kind == "TIC" and events[i].kind == "TAC"],
        dtype=np.float64,
    )
    tac_to_tic = np.array(
        [events[i].dt_prev_s for i in range(1, len(events)) if events[i - 1].kind == "TAC" and events[i].kind == "TIC"],
        dtype=np.float64,
    )

    mean_half = float(np.mean(dts))
    full_period = mean_half * 2.0
    bpm = 60.0 / mean_half

    print("-" * 72)
    print(f"Semiperiodo medio      : {mean_half * 1000:.2f} ms (periodo completo: {full_period:.4f} s | {bpm:.2f} golpes/min)")
    print(f"Desviacion estandar dt : {np.std(dts) * 1000:.2f} ms (min: {np.min(dts)*1000:.2f} ms, max: {np.max(dts)*1000:.2f} ms)")

    if len(tic_to_tac) > 0 and len(tac_to_tic) > 0:
        m1 = float(np.mean(tic_to_tac))
        m2 = float(np.mean(tac_to_tic))
        diff_ms = abs(m1 - m2) * 1000.0
        beat_error_ms = diff_ms / 2.0
        beat_error_pct = (beat_error_ms / (mean_half * 1000.0)) * 100.0
        print(f"TIC -> TAC medio       : {m1 * 1000:.2f} ms (std = {np.std(tic_to_tac)*1000:.2f} ms, n={len(tic_to_tac)})")
        print(f"TAC -> TIC medio       : {m2 * 1000:.2f} ms (std = {np.std(tac_to_tic)*1000:.2f} ms, n={len(tac_to_tic)})")
        print(f"Asimetria (|dt1 - dt2|): {diff_ms:.2f} ms")
        print(f"Beat error (cojera)    : {beat_error_ms:.2f} ms ({beat_error_pct:.2f}% del semiperiodo)")

    print("-" * 72)
    print(f"{'#':>3}  {'Tipo':<4}  {'Inicio(s)':>9}  {'Pico(s)':>9}  {'dt(ms)':>8}  {'Desv(ms)':>9}  {'Dur(ms)':>8}")
    for ev in events:
        dt_str = f"{ev.dt_prev_s * 1000:8.2f}" if ev.dt_prev_s is not None else "       -"
        dev_str = f"{ev.deviation_ms:+9.2f}" if ev.deviation_ms is not None else "        -"
        print(
            f"{ev.index:>3}  {ev.kind:<4}  {ev.onset_s:9.4f}  {ev.peak_s:9.4f}  "
            f"{dt_str}  {dev_str}  {ev.duration_ms:8.1f}"
        )
    print("=" * 72)


def save_csv(csv_path: Path, events: list[TickEvent]) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["index", "kind", "onset_s", "peak_s", "dt_prev_ms", "deviation_ms", "duration_ms", "amplitude"])
        for ev in events:
            writer.writerow(
                [
                    ev.index,
                    ev.kind,
                    f"{ev.onset_s:.6f}",
                    f"{ev.peak_s:.6f}",
                    f"{ev.dt_prev_s * 1000:.3f}" if ev.dt_prev_s is not None else "",
                    f"{ev.deviation_ms:.3f}" if ev.deviation_ms is not None else "",
                    f"{ev.duration_ms:.2f}",
                    f"{ev.amplitude:.6f}",
                ]
            )


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Filtra ruido de fondo y analiza el tic-tac de un reloj de péndulo."
    )
    parser.add_argument("--input", type=Path, default=Path("data/reloj.mpeg"), help="Archivo de audio de entrada.")
    parser.add_argument("--output", type=Path, default=Path("output/reloj_limpio.wav"), help="WAV limpio de salida.")
    parser.add_argument("--csv", type=Path, default=Path("output/reloj_eventos.csv"), help="CSV con tiempos detectados.")
    parser.add_argument("--low-hz", type=float, default=2500.0, help="Frecuencia de corte inferior del pasa-banda (Hz).")
    parser.add_argument("--high-hz", type=float, default=9500.0, help="Frecuencia de corte superior del pasa-banda (Hz).")
    parser.add_argument("--no-gate", action="store_true", help="Desactiva la puerta temporal y deja solo el filtrado espectral.")
    args = parser.parse_args()

    mono, sr, bad_packets = load_audio_mono(args.input)
    duration_s = len(mono) / sr

    bp = zero_phase_bandpass(mono, sr, low_hz=args.low_hz, high_hz=args.high_hz)
    cleaned = spectral_noise_gate(bp, sr)
    events = detect_tick_tacks(bp, sr)

    if not args.no_gate:
        final_audio = apply_temporal_gate(cleaned, sr, events)
    else:
        final_audio = cleaned

    max_val = np.max(np.abs(final_audio))
    if max_val > 0:
        final_audio = 0.9 * (final_audio / max_val)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(args.output), final_audio, sr, subtype="PCM_16")
    save_csv(args.csv, events)
    print_calibration_report(args.input, sr, duration_s, bad_packets, events)
    print(f"Audio limpio guardado en : {args.output}")
    print(f"Eventos guardados en     : {args.csv}")


if __name__ == "__main__":
    main()
