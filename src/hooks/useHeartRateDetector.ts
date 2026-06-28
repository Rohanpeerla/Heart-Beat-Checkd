import { useState, useRef, useCallback, useEffect } from 'react';

export type CameraMode = 'rear' | 'front';

export interface HRData {
  bpm: number;
  confidence: number;
  signal: number[];
  rawSignal: number[];
  peaks: number[];
  avgRedLevel: number;
  fingerDetected: boolean;
  status: 'idle' | 'starting' | 'detecting' | 'measuring' | 'error';
  errorMsg: string;
  beatTimestamps: number[];
  lastBeatTime: number;
  cameraMode: CameraMode;
}

const BUFFER_SIZE = 512;

export function useHeartRateDetector() {
  const [data, setData] = useState<HRData>({
    bpm: 0, confidence: 0, signal: [], rawSignal: [],
    peaks: [], avgRedLevel: 0, fingerDetected: false,
    status: 'idle', errorMsg: '', beatTimestamps: [], lastBeatTime: 0,
    cameraMode: 'rear',
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const isRunningRef = useRef(false);
  const cameraModeRef = useRef<CameraMode>('rear');

  const rawRedRef = useRef<number[]>([]);
  const timestampsRef = useRef<number[]>([]);
  const rawDisplayRef = useRef<number[]>([]);

  const beatTimesRef = useRef<number[]>([]);
  const lastPeakTimeRef = useRef(0);

  const smoothBpmRef = useRef(0);
  const lastGoodBpmRef = useRef(0);        // persist last good reading
  const lastGoodConfRef = useRef(0);
  const bpmStaleCountRef = useRef(0);       // frames since last good calc
  const frameCountRef = useRef(0);
  const lastUIUpdateRef = useRef(0);

  // ===== SIGNAL PROCESSING =====

  const movingAvg = (arr: number[], windowSize: number): number[] => {
    const result: number[] = new Array(arr.length);
    const half = Math.floor(windowSize / 2);
    let sum = 0;
    for (let i = 0; i < Math.min(windowSize, arr.length); i++) sum += arr[i];
    for (let i = 0; i < arr.length; i++) {
      const left = i - half - 1;
      const right = i + half;
      if (right < arr.length) sum += arr[right];
      if (left >= 0) sum -= arr[left];
      const lo = Math.max(0, i - half);
      const hi = Math.min(arr.length - 1, i + half);
      result[i] = sum / (hi - lo + 1);
    }
    return result;
  };

  const bandpassFilter = (arr: number[]): number[] => {
    if (arr.length < 20) return arr;
    const smoothed = movingAvg(arr, 9);
    const baseline = movingAvg(smoothed, 61);
    return smoothed.map((v, i) => v - baseline[i]);
  };

  const rejectSpike = (buffer: number[], newVal: number): number => {
    if (buffer.length < 5) return newVal;
    const recent = buffer.slice(-10);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const std = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length);
    if (std > 0 && Math.abs(newVal - mean) > 3 * std) return mean;
    return newVal;
  };

  const findPeaks = (signal: number[]): number[] => {
    if (signal.length < 30) return [];
    const values = signal.slice(-200);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    const threshold = mean + std * 0.4;
    const minDistance = 9;
    const peaks: number[] = [];

    for (let i = 2; i < signal.length - 2; i++) {
      const v = signal[i];
      if (v <= threshold) continue;
      if (v < signal[i - 1] || v < signal[i + 1]) continue;
      if (v < signal[i - 2] || v < signal[i + 2]) continue;
      if (peaks.length > 0 && i - peaks[peaks.length - 1] < minDistance) {
        if (v > signal[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
        continue;
      }
      peaks.push(i);
    }
    return peaks;
  };

  const calculateBPM = (beatTimes: number[]): { bpm: number; confidence: number } => {
    const now = Date.now();

    // Use wider window: keep beats from last 20 seconds (was 12)
    const recent = beatTimes.filter(t => now - t < 20000);

    // Need at least 3 beats (was 4 — too strict, caused drops)
    if (recent.length < 3) {
      // Instead of returning 0, return last known good BPM with decaying confidence
      if (lastGoodBpmRef.current > 0) {
        bpmStaleCountRef.current++;
        // Confidence drops as stale time increases, but BPM stays visible
        const decayedConf = Math.max(5, lastGoodConfRef.current - bpmStaleCountRef.current * 3);
        return { bpm: lastGoodBpmRef.current, confidence: decayedConf };
      }
      return { bpm: 0, confidence: 0 };
    }

    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) intervals.push(recent[i] - recent[i - 1]);

    const sorted = [...intervals].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const clean = intervals.filter(i => i >= Math.max(280, q1 - 1.5 * iqr) && i <= Math.min(1600, q3 + 1.5 * iqr));

    if (clean.length < 2) {
      // Not enough clean intervals — use last known BPM
      if (lastGoodBpmRef.current > 0) {
        bpmStaleCountRef.current++;
        const decayedConf = Math.max(5, lastGoodConfRef.current - bpmStaleCountRef.current * 3);
        return { bpm: lastGoodBpmRef.current, confidence: decayedConf };
      }
      return { bpm: 0, confidence: 0 };
    }

    const avg = clean.reduce((a, b) => a + b, 0) / clean.length;
    const rawBpm = 60000 / avg;
    if (rawBpm < 40 || rawBpm > 200) {
      if (lastGoodBpmRef.current > 0) {
        bpmStaleCountRef.current++;
        const decayedConf = Math.max(5, lastGoodConfRef.current - bpmStaleCountRef.current * 3);
        return { bpm: lastGoodBpmRef.current, confidence: decayedConf };
      }
      return { bpm: 0, confidence: 0 };
    }

    // Smooth BPM
    if (smoothBpmRef.current === 0) smoothBpmRef.current = rawBpm;
    else smoothBpmRef.current = smoothBpmRef.current * 0.8 + rawBpm * 0.2;

    const bpm = Math.round(smoothBpmRef.current);
    const variance = clean.reduce((sum, i) => sum + (i - avg) ** 2, 0) / clean.length;
    const cv = Math.sqrt(variance) / avg;
    const confidence = Math.max(0, Math.min(100, Math.round((1 - cv * 3) * 100)));

    // Save as last known good reading
    lastGoodBpmRef.current = bpm;
    lastGoodConfRef.current = confidence;
    bpmStaleCountRef.current = 0;

    return { bpm, confidence };
  };

  // ===== FINGER DETECTION =====
  const detectFinger = (avgRed: number, avgGreen: number, avgBlue: number): boolean => {
    if (cameraModeRef.current === 'rear') {
      return avgRed > 80 && avgRed > avgGreen * 1.3 && avgRed > avgBlue * 1.3;
    } else {
      const brightness = (avgRed + avgGreen + avgBlue) / 3;
      const redRatio = avgRed / (brightness || 1);
      return (
        (avgRed > 50 && redRatio > 1.15 && avgRed > avgBlue * 1.15) ||
        (brightness < 60 && brightness > 5 && avgRed > avgGreen * 1.05)
      );
    }
  };

  // ===== MAIN FRAME LOOP =====

  const processFrame = useCallback(() => {
    if (!isRunningRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      animFrameRef.current = requestAnimationFrame(processFrame);
      return;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) { animFrameRef.current = requestAnimationFrame(processFrame); return; }

    const w = 48, h = 48;
    canvas.width = w;
    canvas.height = h;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const cropSize = Math.min(vw, vh) * 0.5;
    const sx = (vw - cropSize) / 2;
    const sy = (vh - cropSize) / 2;
    ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    const pixels = imageData.data;
    const pixelCount = w * h;

    let totalRed = 0, totalGreen = 0, totalBlue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      totalRed += pixels[i];
      totalGreen += pixels[i + 1];
      totalBlue += pixels[i + 2];
    }

    let avgRed = totalRed / pixelCount;
    const avgGreen = totalGreen / pixelCount;
    const avgBlue = totalBlue / pixelCount;

    const fingerDetected = detectFinger(avgRed, avgGreen, avgBlue);
    frameCountRef.current++;

    let signalValue: number;
    if (cameraModeRef.current === 'front') {
      signalValue = rejectSpike(rawRedRef.current, (avgRed + avgGreen) / 2);
    } else {
      signalValue = rejectSpike(rawRedRef.current, avgRed);
    }

    rawDisplayRef.current.push(signalValue);
    if (rawDisplayRef.current.length > 600) rawDisplayRef.current.shift();

    const now = Date.now();

    if (fingerDetected) {
      rawRedRef.current.push(signalValue);
      timestampsRef.current.push(now);

      if (rawRedRef.current.length > BUFFER_SIZE) {
        rawRedRef.current.shift();
        timestampsRef.current.shift();
      }

      const bufLen = rawRedRef.current.length;

      if (bufLen > 90) {
        const filtered = bandpassFilter(rawRedRef.current);
        const peaks = findPeaks(filtered);

        let newBeatTime = 0;
        for (const peakIdx of peaks) {
          const peakTime = timestampsRef.current[peakIdx];
          if (!peakTime) continue;
          if (peakTime <= lastPeakTimeRef.current) continue;
          if (beatTimesRef.current.length > 0) {
            const interval = peakTime - beatTimesRef.current[beatTimesRef.current.length - 1];
            if (interval < 300 || interval > 2000) continue;
          }
          beatTimesRef.current.push(peakTime);
          lastPeakTimeRef.current = peakTime;
          newBeatTime = peakTime;
          if (beatTimesRef.current.length > 60) beatTimesRef.current.shift();
        }

        const { bpm, confidence } = calculateBPM(beatTimesRef.current);

        if (now - lastUIUpdateRef.current > 66) {
          lastUIUpdateRef.current = now;
          const displaySignal = filtered.slice(-250);
          const displayPeaks = peaks.filter(p => p >= bufLen - 250).map(p => p - (bufLen - 250));

          setData({
            bpm, confidence,
            signal: displaySignal,
            rawSignal: rawDisplayRef.current.slice(-400),
            peaks: displayPeaks,
            avgRedLevel: avgRed,
            fingerDetected: true,
            status: bpm > 0 ? 'measuring' : 'detecting',
            errorMsg: '',
            beatTimestamps: [...beatTimesRef.current],
            lastBeatTime: newBeatTime || 0,
            cameraMode: cameraModeRef.current,
          });
        } else if (newBeatTime > 0) {
          setData(prev => ({ ...prev, lastBeatTime: newBeatTime }));
        }
      } else {
        // Collecting initial data — but if we have a previous BPM, keep showing it
        if (now - lastUIUpdateRef.current > 100) {
          lastUIUpdateRef.current = now;
          setData(prev => ({
            ...prev,
            bpm: lastGoodBpmRef.current > 0 ? lastGoodBpmRef.current : prev.bpm,
            avgRedLevel: avgRed,
            fingerDetected: true,
            status: lastGoodBpmRef.current > 0 ? 'measuring' : 'detecting',
            rawSignal: rawDisplayRef.current.slice(-400),
            cameraMode: cameraModeRef.current,
          }));
        }
      }
    } else {
      // Finger removed — KEEP the last known BPM, just update finger status
      if (now - lastUIUpdateRef.current > 200) {
        lastUIUpdateRef.current = now;
        setData(prev => ({
          ...prev,
          avgRedLevel: avgRed,
          fingerDetected: false,
          // Keep BPM showing — don't reset to 0
          bpm: lastGoodBpmRef.current > 0 ? lastGoodBpmRef.current : prev.bpm,
          rawSignal: rawDisplayRef.current.slice(-400),
          cameraMode: cameraModeRef.current,
        }));
      }
    }

    animFrameRef.current = requestAnimationFrame(processFrame);
  }, []);

  // ===== START / STOP =====

  const start = useCallback(async (mode: CameraMode = 'rear') => {
    try {
      cameraModeRef.current = mode;
      setData(prev => ({ ...prev, status: 'starting', errorMsg: '', cameraMode: mode }));

      const facingMode = mode === 'front' ? 'user' : 'environment';

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 320 },
          height: { ideal: 240 },
        },
        audio: false,
      });

      streamRef.current = stream;

      if (mode === 'rear') {
        const track = stream.getVideoTracks()[0];
        try {
          await track.applyConstraints({
            advanced: [
              { torch: true } as any,
              { exposureMode: 'manual' } as any,
              { whiteBalanceMode: 'manual' } as any,
            ],
          });
        } catch {
          try {
            await track.applyConstraints({ advanced: [{ torch: true } as any] });
          } catch {
            console.log('Torch not available');
          }
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
      }

      // Reset buffers but NOT the last known BPM
      rawRedRef.current = [];
      rawDisplayRef.current = [];
      timestampsRef.current = [];
      beatTimesRef.current = [];
      frameCountRef.current = 0;
      lastPeakTimeRef.current = 0;
      smoothBpmRef.current = 0;
      lastUIUpdateRef.current = 0;
      lastGoodBpmRef.current = 0;
      lastGoodConfRef.current = 0;
      bpmStaleCountRef.current = 0;

      isRunningRef.current = true;
      animFrameRef.current = requestAnimationFrame(processFrame);

      setData(prev => ({ ...prev, status: 'detecting', cameraMode: mode }));
    } catch (err: any) {
      let msg = 'Could not access camera.';
      if (err.name === 'NotAllowedError') msg = 'Camera permission denied. Please allow camera access and try again.';
      else if (err.name === 'NotFoundError') msg = 'No camera found on this device.';
      else if (err.name === 'NotReadableError') msg = 'Camera is in use by another app.';
      setData(prev => ({ ...prev, status: 'error', errorMsg: msg }));
    }
  }, [processFrame]);

  const stop = useCallback(() => {
    isRunningRef.current = false;
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    // Don't reset smoothBpmRef — keep it for display
    setData(prev => ({ ...prev, status: 'idle' }));
  }, []);

  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    };
  }, []);

  return { data, start, stop, videoRef, canvasRef };
}
