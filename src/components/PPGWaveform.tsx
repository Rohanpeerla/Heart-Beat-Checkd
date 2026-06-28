import { useEffect, useRef, useCallback } from 'react';
import { HRData } from '../hooks/useHeartRateDetector';

interface PPGWaveformProps {
  data: HRData;
}

const PPGWaveform = ({ data }: PPGWaveformProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const dataRef = useRef<HRData>(data);
  const prevLenRef = useRef(0);
  const beatFlashRef = useRef(0);    // timestamp of last beat flash

  // Keep latest data in ref for animation loop
  useEffect(() => {
    // Detect new beat for flash effect
    if (data.lastBeatTime > 0 && data.lastBeatTime !== dataRef.current.lastBeatTime) {
      beatFlashRef.current = Date.now();
    }
    prevLenRef.current = data.rawSignal.length;
    dataRef.current = data;
  }, [data]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) { animRef.current = requestAnimationFrame(draw); return; }

    const ctx = canvas.getContext('2d');
    if (!ctx) { animRef.current = requestAnimationFrame(draw); return; }

    const w = canvas.width;
    const h = canvas.height;
    const now = Date.now();
    const d = dataRef.current;

    // ---- BACKGROUND ----
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, w, h);

    // ---- GRID ----
    const gs = 20;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.06)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < w; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.12)';
    ctx.lineWidth = 0.8;
    for (let x = 0; x < w; x += gs * 5) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += gs * 5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    // Center line
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);

    const signal = d.signal;
    const peaks = d.peaks;

    if (signal.length < 3) {
      // Waiting animation — pulsing dot
      const pulseR = 4 + Math.sin(now / 400) * 2;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, pulseR, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
      ctx.fill();

      ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.fingerDetected ? 'Detecting pulse...' : 'Place finger on camera', w / 2, h / 2 + 25);

      animRef.current = requestAnimationFrame(draw);
      return;
    }

    // ---- SIGNAL SCALING ----
    const min = Math.min(...signal);
    const max = Math.max(...signal);
    const range = max - min || 1;
    const pad = 20;
    const drawH = h - pad * 2;

    // How many points fit on screen — show last N that fill the width
    const pointSpacing = 3; // pixels per sample
    const visiblePoints = Math.floor((w - pad) / pointSpacing);
    const startIdx = Math.max(0, signal.length - visiblePoints);
    const visible = signal.slice(startIdx);
    const visiblePeaks = peaks
      .map(p => p - startIdx)
      .filter(p => p >= 0 && p < visible.length);

    // ---- BEAT FLASH BACKGROUND ----
    const beatAge = now - beatFlashRef.current;
    if (beatAge < 400 && d.bpm > 0) {
      const flashAlpha = Math.max(0, 0.12 * (1 - beatAge / 400));
      ctx.fillStyle = `rgba(239, 68, 68, ${flashAlpha})`;
      ctx.fillRect(0, 0, w, h);
    }

    // ---- TRAILING GLOW (fading tail) ----
    // Draw a faint filled area under the curve
    ctx.beginPath();
    ctx.moveTo(pad / 2, h - pad);
    for (let i = 0; i < visible.length; i++) {
      const x = pad / 2 + i * pointSpacing;
      const norm = (visible[i] - min) / range;
      const y = pad + drawH - norm * drawH;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(pad / 2 + (visible.length - 1) * pointSpacing, h - pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad, 0, h - pad);
    grad.addColorStop(0, 'rgba(239, 68, 68, 0.08)');
    grad.addColorStop(1, 'rgba(239, 68, 68, 0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // ---- MAIN WAVEFORM LINE ----
    ctx.beginPath();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#ef4444';

    for (let i = 0; i < visible.length; i++) {
      const x = pad / 2 + i * pointSpacing;
      const norm = (visible[i] - min) / range;
      const y = pad + drawH - norm * drawH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // ---- BRIGHT TIP at the leading edge ----
    if (visible.length > 0) {
      const tipIdx = visible.length - 1;
      const tipX = pad / 2 + tipIdx * pointSpacing;
      const tipNorm = (visible[tipIdx] - min) / range;
      const tipY = pad + drawH - tipNorm * drawH;

      // Bright dot
      ctx.beginPath();
      ctx.arc(tipX, tipY, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#ef4444';
      ctx.fill();
      ctx.shadowBlur = 0;

      // Cursor vertical line
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.moveTo(tipX, 0);
      ctx.lineTo(tipX, h);
      ctx.stroke();
    }

    // ---- PEAK MARKERS (beats) ----
    visiblePeaks.forEach(pIdx => {
      const x = pad / 2 + pIdx * pointSpacing;
      const norm = (visible[pIdx] - min) / range;
      const y = pad + drawH - norm * drawH;

      // Vertical beat marker
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.15)';
      ctx.lineWidth = 1;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      // Beat dot
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fbbf24';
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#fbbf24';
      ctx.fill();
      ctx.shadowBlur = 0;

      // Small beat label
      ctx.fillStyle = 'rgba(251, 191, 36, 0.6)';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('♥', x, y - 12);
    });

    // ---- BPM OVERLAY (top right) ----
    if (d.bpm > 0) {
      ctx.textAlign = 'right';

      // BPM number
      ctx.font = 'bold 28px monospace';
      ctx.fillStyle = beatAge < 200 ? '#ff6b6b' : '#ef4444';
      ctx.shadowBlur = beatAge < 200 ? 15 : 0;
      ctx.shadowColor = '#ef4444';
      ctx.fillText(`${d.bpm}`, w - 12, 32);
      ctx.shadowBlur = 0;

      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(239, 68, 68, 0.5)';
      ctx.fillText('BPM', w - 12, 44);
    }

    // ---- LABEL (top left) ----
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(239, 68, 68, 0.35)';
    ctx.font = '10px monospace';
    ctx.fillText('PPG Live', 6, 14);

    // ---- HEARTBEAT PULSE RING ----
    if (beatAge < 500 && d.bpm > 0) {
      const ringProgress = beatAge / 500;
      const ringR = 8 + ringProgress * 25;
      const ringAlpha = 0.5 * (1 - ringProgress);

      // Place ring at most recent beat position
      if (visiblePeaks.length > 0) {
        const lastPeak = visiblePeaks[visiblePeaks.length - 1];
        const px = pad / 2 + lastPeak * pointSpacing;
        const pNorm = (visible[lastPeak] - min) / range;
        const py = pad + drawH - pNorm * drawH;

        ctx.beginPath();
        ctx.arc(px, py, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239, 68, 68, ${ringAlpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    animRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };
    resize();
    window.addEventListener('resize', resize);

    animRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animRef.current);
    };
  }, [draw]);

  return (
    <div className="w-full h-full bg-black rounded-lg overflow-hidden relative">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
};

export default PPGWaveform;
