import { useState, useRef, useCallback, useEffect } from 'react';

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
}

const BUFFER_SIZE = 512;
const MIN_RED_THRESHOLD = 80;

// Bandpass filter: only pass 0.7–3.5 Hz (42–210 BPM) at ~30fps
// These are simple IIR butterworth coefficients for that range
// We'll use a simpler approach: subtract two moving averages

export function useHeartRateDetector() {
  const [data, setData] = useState<HRData>({
    bpm: 0, confidence: 0, signal: [], rawSignal: [],
    peaks: [], avgRedLevel: 0, fingerDetected: false,
    status: 'idle', errorMsg: '', beatTimestamps: [], lastBeatTime: 0,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const isRunningRef = useRef(false);

  // Signal buffers
  const rawRedRef = useRef<number[]>([]);
  const timestampsRef = useRef<number[]>([]);
  const rawDisplayRef = useRef<number[]>([]);

  // Beat tracking
  const beatTimesRef = useRef<number[]>([]);
  const lastPeakTimeRef = useRef(0);

  // BPM smoothing — exponential moving average
  const smoothBpmRef = useRef(0);
  const frameCountRef = useRef(0);

  // State update throttle
  const lastUIUpdateRef = useRef(0);

  // ===== SIGNAL PROCESSING =====

  // Moving average
  const movingAvg = (arr: number[], windowSize: number): number[] => {
    const result: number[] = new Array(arr.length);
    let sum = 0;
    const half = Math.floor(windowSize / 2);

    // Initialize
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

  // Bandpass via difference of moving averages
  // Slow MA removes noise (high freq), fast MA removes baseline drift (low freq)
  // Result ≈ bandpass filtered signal
  const bandpassFilter = (arr: number[]): number[] => {
    if (arr.length < 20) return arr;

    // Smooth heavily to kill high-frequency noise (window ~9 frames ≈ 3.3Hz cutoff at 30fps)
    const smoothed = movingAvg(arr, 9);

    // Remove slow baseline drift (window ~60 frames ≈ 0.5Hz cutoff at 30fps)
    const baseline = movingAvg(smoothed, 61);

    // Subtract baseline to get just the heartbeat oscillation
    return smoothed.map((v, i) => v - baseline[i]);
  };

  // Reject outlier raw values (camera auto-exposure spikes)
  const rejectSpike = (buffer: number[], newVal: number): number => {
    if (buffer.length < 5) return newVal;
    const recent = buffer.slice(-10);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const std = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length);

    // If new value is more than 3 standard deviations away, clamp it
    if (std > 0 && Math.abs(newVal - mean) > 3 * std) {
      return mean; // Replace spike with mean
    }
    return newVal;
  };

  // Robust peak detection with adaptive threshold
  const findPeaks = (signal: number[]): number[] => {
    if (signal.length < 30) return [];

    // Calculate signal statistics
    const values = signal.slice(-200);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);

    // Adaptive threshold: peak must be at least 0.4 standard deviations above mean
    const threshold = mean + std * 0.4;

    // Minimum distance between peaks: at 200bpm = ~9 frames at 30fps
    const minDistance = 9;

    const peaks: number[] = [];

    for (let i = 2; i < signal.length - 2; i++) {
      const v = signal[i];

      // Must be above threshold
      if (v <= threshold) continue;

      // Must be a local maximum (check 2 neighbors on each side for robustness)
      if (v < signal[i - 1] || v < signal[i + 1]) continue;
      if (v < signal[i - 2] || v < signal[i + 2]) continue;

      // Must be far enough from last peak
      if (peaks.length > 0 && i - peaks[peaks.length - 1] < minDistance) {
        // If this peak is higher than the last one (within min distance), replace it
        if (v > signal[peaks[peaks.length - 1]]) {
          peaks[peaks.length - 1] = i;
        }
        continue;
      }

      peaks.push(i);
    }

    return peaks;
  };

  // Calculate BPM from beat timestamps with outlier rejection
  const calculateBPM = (beatTimes: number[]): { bpm: number; confidence: number } => {
    if (beatTimes.length < 4) return { bpm: 0, confidence: 0 };

    const now = Date.now();
    const recent = beatTimes.filter(t => now - t < 12000);
    if (recent.length < 4) return { bpm: 0, confidence: 0 };

    // Calculate all inter-beat intervals
    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      intervals.push(recent[i] - recent[i - 1]);
    }

    // Remove outliers: use IQR method
    const sorted = [...intervals].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    const clean = intervals.filter(i => i >= Math.max(300, lowerBound) && i <= Math.min(1500, upperBound));
    if (clean.length < 2) return { bpm: 0, confidence: 0 };

    const avgInterval = clean.reduce((a, b) => a + b, 0) / clean.length;
    const rawBpm = 60000 / avgInterval;

    if (rawBpm < 40 || rawBpm > 200) return { bpm: 0, confidence: 0 };

    // Smooth BPM: exponential moving average to prevent jumps
    if (smoothBpmRef.current === 0) {
      smoothBpmRef.current = rawBpm;
    } else {
      // Blend: 80% old value + 20% new value for stability
      const alpha = 0.2;
      smoothBpmRef.current = smoothBpmRef.current * (1 - alpha) + rawBpm * alpha;
    }

    const bpm = Math.round(smoothBpmRef.current);

    // Confidence from interval consistency
    const variance = clean.reduce((sum, i) => sum + (i - avgInterval) ** 2, 0) / clean.length;
    const cv = Math.sqrt(variance) / avgInterval;
    const confidence = Math.max(0, Math.min(100, Math.round((1 - cv * 3) * 100)));

    return { bpm, confidence };
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
    if (!ctx) {
      animFrameRef.current = requestAnimationFrame(processFrame);
      return;
    }

    // Sample center region of frame (avoid edge artifacts)
    const w = 48;
    const h = 48;
    canvas.width = w;
    canvas.height = h;

    // Draw center crop of video for more stable readings
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

    // Finger detection: dominant red channel when finger covers flash
    const fingerDetected = avgRed > MIN_RED_THRESHOLD &&
                           avgRed > avgGreen * 1.3 &&
                           avgRed > avgBlue * 1.3;

    frameCountRef.current++;

    // Reject camera auto-exposure spikes
    avgRed = rejectSpike(rawRedRef.current, avgRed);

    // Always push to display buffer
    rawDisplayRef.current.push(avgRed);
    if (rawDisplayRef.current.length > 600) rawDisplayRef.current.shift();

    const now = Date.now();

    if (fingerDetected) {
      rawRedRef.current.push(avgRed);
      timestampsRef.current.push(now);

      if (rawRedRef.current.length > BUFFER_SIZE) {
        rawRedRef.current.shift();
        timestampsRef.current.shift();
      }

      const bufLen = rawRedRef.current.length;

      // Need at least ~3 seconds of data (90 frames at 30fps)
      if (bufLen > 90) {
        // Apply bandpass filter
        const filtered = bandpassFilter(rawRedRef.current);

        // Find peaks in filtered signal
        const peaks = findPeaks(filtered);

        // Register new beats
        let newBeatTime = 0;
        for (const peakIdx of peaks) {
          const peakTime = timestampsRef.current[peakIdx];
          if (!peakTime) continue;

          // Must be new (not already registered) and reasonable interval
          if (peakTime <= lastPeakTimeRef.current) continue;
          if (beatTimesRef.current.length > 0) {
            const interval = peakTime - beatTimesRef.current[beatTimesRef.current.length - 1];
            if (interval < 300 || interval > 2000) continue; // 30-200 BPM range
          }

          beatTimesRef.current.push(peakTime);
          lastPeakTimeRef.current = peakTime;
          newBeatTime = peakTime;

          if (beatTimesRef.current.length > 40) beatTimesRef.current.shift();
        }

        const { bpm, confidence } = calculateBPM(beatTimesRef.current);

        // Throttle UI updates to ~15fps to reduce React overhead
        if (now - lastUIUpdateRef.current > 66) {
          lastUIUpdateRef.current = now;

          const displaySignal = filtered.slice(-250);
          const displayPeaks = peaks
            .filter(p => p >= bufLen - 250)
            .map(p => p - (bufLen - 250));

          setData({
            bpm,
            confidence,
            signal: displaySignal,
            rawSignal: rawDisplayRef.current.slice(-400),
            peaks: displayPeaks,
            avgRedLevel: avgRed,
            fingerDetected: true,
            status: bpm > 0 ? 'measuring' : 'detecting',
            errorMsg: '',
            beatTimestamps: [...beatTimesRef.current],
            lastBeatTime: newBeatTime || 0,
          });
        } else if (newBeatTime > 0) {
          // Always push beat events immediately for heart animation
          setData(prev => ({ ...prev, lastBeatTime: newBeatTime }));
        }
      } else {
        // Still collecting initial data
        if (now - lastUIUpdateRef.current > 100) {
          lastUIUpdateRef.current = now;
          setData(prev => ({
            ...prev,
            avgRedLevel: avgRed,
            fingerDetected: true,
            status: 'detecting',
            rawSignal: rawDisplayRef.current.slice(-400),
          }));
        }
      }
    } else {
      // Finger removed — keep last BPM but update status
      if (now - lastUIUpdateRef.current > 200) {
        lastUIUpdateRef.current = now;
        setData(prev => ({
          ...prev,
          avgRedLevel: avgRed,
          fingerDetected: false,
          rawSignal: rawDisplayRef.current.slice(-400),
        }));
      }
    }

    animFrameRef.current = requestAnimationFrame(processFrame);
  }, []);

  // ===== START / STOP =====

  const start = useCallback(async () => {
    try {
      setData(prev => ({ ...prev, status: 'starting', errorMsg: '' }));

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 320 },   // Lower res = faster processing
          height: { ideal: 240 },
        },
        audio: false,
      });

      streamRef.current = stream;

      // Try to lock exposure and enable torch for consistent readings
      const track = stream.getVideoTracks()[0];
      try {
        await track.applyConstraints({
          advanced: [
            { torch: true } as any,
            // Try to lock exposure to prevent auto-brightness spikes
            { exposureMode: 'manual' } as any,
            { whiteBalanceMode: 'manual' } as any,
          ],
        });
      } catch {
        // Try just torch
        try {
          await track.applyConstraints({ advanced: [{ torch: true } as any] });
        } catch {
          console.log('Torch not available');
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
      }

      // Reset everything
      rawRedRef.current = [];
      rawDisplayRef.current = [];
      timestampsRef.current = [];
      beatTimesRef.current = [];
      frameCountRef.current = 0;
      lastPeakTimeRef.current = 0;
      smoothBpmRef.current = 0;
      lastUIUpdateRef.current = 0;

      isRunningRef.current = true;
      animFrameRef.current = requestAnimationFrame(processFrame);

      setData(prev => ({ ...prev, status: 'detecting' }));
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
    smoothBpmRef.current = 0;
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
