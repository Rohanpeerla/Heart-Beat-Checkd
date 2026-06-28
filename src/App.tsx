import { useState, useEffect, useRef, useCallback } from 'react';
import { useHeartRateDetector, CameraMode } from './hooks/useHeartRateDetector';
import PPGWaveform from './components/PPGWaveform';

// Continuous monitoring timer
function MonitorTimer({ isRunning }: { isRunning: boolean }) {
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (isRunning) {
      if (!startRef.current) startRef.current = Date.now() - seconds * 1000;
      const interval = setInterval(() => {
        setSeconds(Math.floor((Date.now() - (startRef.current || Date.now())) / 1000));
      }, 1000);
      return () => clearInterval(interval);
    } else {
      startRef.current = null;
    }
  }, [isRunning]);

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return <>{mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`}</>;
}

function App() {
  const { data, start, stop, videoRef, canvasRef } = useHeartRateDetector();
  const [bpmHistory, setBpmHistory] = useState<number[]>([]);
  const [showInfo, setShowInfo] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [heartScale, setHeartScale] = useState(1);
  const [prevLastBeat, setPrevLastBeat] = useState(0);
  const [selectedCamera, setSelectedCamera] = useState<CameraMode>('rear');
  const audioCtxRef = useRef<AudioContext | null>(null);

  const isActive = data.status === 'detecting' || data.status === 'measuring';
  const isFrontCamera = data.cameraMode === 'front';

  // Screen flash: when front camera is active and finger is on, we make the
  // entire background bright white to illuminate the finger from the screen side
  const showScreenFlash = isFrontCamera && isActive;

  useEffect(() => {
    const t = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Track BPM history
  useEffect(() => {
    if (data.bpm > 0 && data.confidence > 40) {
      setBpmHistory(prev => {
        const next = [...prev, data.bpm];
        if (next.length > 60) next.shift();
        return next;
      });
    }
  }, [data.bpm, data.confidence]);

  // Play beep on beat
  const playBeat = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 660;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
    } catch {
      // Audio not supported
    }
  }, []);

  // Beat animation + sound
  useEffect(() => {
    if (data.lastBeatTime > 0 && data.lastBeatTime !== prevLastBeat) {
      setPrevLastBeat(data.lastBeatTime);
      setHeartScale(1.3);
      const t1 = setTimeout(() => setHeartScale(1.05), 120);
      const t2 = setTimeout(() => setHeartScale(1), 250);
      playBeat();
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [data.lastBeatTime, prevLastBeat, playBeat]);

  const handleStart = useCallback(() => {
    setBpmHistory([]);
    start(selectedCamera);
  }, [start, selectedCamera]);

  const handleStop = useCallback(() => {
    stop();
    setBpmHistory([]);
  }, [stop]);

  const avgBpm = bpmHistory.length > 0 ? Math.round(bpmHistory.reduce((a, b) => a + b, 0) / bpmHistory.length) : 0;
  const minBpm = bpmHistory.length > 0 ? Math.min(...bpmHistory) : 0;
  const maxBpm = bpmHistory.length > 0 ? Math.max(...bpmHistory) : 0;

  const getStatusText = () => {
    const cam = isFrontCamera ? 'front' : 'rear';
    switch (data.status) {
      case 'idle': return 'Tap START to begin';
      case 'starting': return 'Accessing camera...';
      case 'detecting':
        if (!data.fingerDetected) {
          return isFrontCamera
            ? 'Place finger on the front camera'
            : 'Place finger on the rear camera';
        }
        return 'Analyzing signal — hold still...';
      case 'measuring':
        if (data.confidence <= 10) return 'Holding last reading — recalibrating...';
        if (data.confidence < 40) return 'Stabilizing — keep your finger still...';
        if (data.confidence < 65) return 'Measuring — signal improving...';
        return `Continuously monitoring ♥ (${cam} cam)`;
      case 'error': return data.errorMsg;
      default: return '';
    }
  };

  const getStatusColor = () => {
    if (data.status === 'measuring') return data.confidence > 50 ? 'text-green-400' : 'text-yellow-400';
    if (data.status === 'detecting') return 'text-yellow-400';
    if (data.status === 'error') return 'text-red-400';
    return 'text-gray-400';
  };

  const getBPMZone = () => {
    if (data.bpm === 0) return { label: '—', color: 'text-gray-600', bg: 'bg-gray-900' };
    if (data.bpm < 60) return { label: 'LOW', color: 'text-blue-400', bg: 'bg-blue-950/40' };
    if (data.bpm <= 100) return { label: 'NORMAL', color: 'text-green-400', bg: 'bg-green-950/40' };
    if (data.bpm <= 140) return { label: 'ELEVATED', color: 'text-yellow-400', bg: 'bg-yellow-950/40' };
    return { label: 'HIGH', color: 'text-red-400', bg: 'bg-red-950/40' };
  };

  const zone = getBPMZone();

  return (
    <div className="min-h-screen flex flex-col relative" style={{
      backgroundColor: showScreenFlash ? '#ffffff' : '#030712',
      transition: 'background-color 0.3s',
    }}>

      {/* ===== SCREEN FLASH OVERLAY (front camera) ===== */}
      {/* When front camera is active, the screen glows bright white to act as a flash */}
      {showScreenFlash && (
        <div
          className="fixed inset-0 pointer-events-none z-50 transition-opacity duration-300"
          style={{
            background: 'radial-gradient(circle at 50% 15%, #ffffff 0%, #f8f8f8 40%, #e0e0e0 100%)',
            opacity: data.fingerDetected ? 1 : 0.85,
          }}
        />
      )}

      {/* All content sits above the flash */}
      <div className={`relative z-[60] flex flex-col min-h-screen ${showScreenFlash ? '' : ''}`}>

        {/* Hidden camera elements */}
        <video ref={videoRef} className="hidden" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />

        {/* Header */}
        <div className={`px-4 py-3 border-b flex items-center justify-between backdrop-blur-sm ${
          showScreenFlash
            ? 'border-gray-300 bg-white/90'
            : 'border-gray-800/50 bg-gray-900/60'
        }`}>
          <div className="flex items-center gap-2.5">
            <span className="text-xl" style={{
              transform: `scale(${heartScale})`,
              transition: 'transform 0.1s ease-out',
              display: 'inline-block',
            }}>❤️</span>
          <div>
              <div className="flex items-center gap-2">
                <h1 className={`font-bold text-base leading-tight ${showScreenFlash ? 'text-gray-800' : 'text-white'}`}>
                  Heart Rate Monitor
                </h1>
                {isActive && data.fingerDetected && (
                  <span className="flex items-center gap-1 bg-red-600 text-white text-[9px] font-mono font-bold px-1.5 py-0.5 rounded">
                    <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                    LIVE
                  </span>
                )}
              </div>
              <p className={`text-[9px] font-mono ${showScreenFlash ? 'text-gray-500' : 'text-gray-600'}`}>
                {isActive
                  ? isFrontCamera ? 'Front Camera + Screen Flash' : 'Rear Camera + Torch'
                  : 'Camera PPG • Estimate'
                }
              </p>
            </div>
          </div>
          <div className={`font-mono text-xs ${showScreenFlash ? 'text-gray-500' : 'text-gray-600'}`}>
            {currentTime.toLocaleTimeString('en-US', { hour12: false })}
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col max-w-2xl mx-auto w-full">

          {/* ===== CAMERA SELECTOR (only when idle) ===== */}
          {!isActive && data.status !== 'starting' && (
            <div className="px-4 pt-4 pb-2">
              <div className="text-gray-500 text-[10px] font-mono mb-2 text-center">SELECT CAMERA</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setSelectedCamera('rear')}
                  className={`p-3 rounded-xl border-2 text-left transition-all ${
                    selectedCamera === 'rear'
                      ? 'border-red-500 bg-red-950/30'
                      : 'border-gray-800 bg-gray-900/80 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">📸</span>
                    <span className={`font-mono text-sm font-bold ${selectedCamera === 'rear' ? 'text-red-400' : 'text-gray-400'}`}>
                      Rear Camera
                    </span>
                  </div>
                  <p className="text-gray-500 text-[10px] font-mono leading-tight">
                    Uses flash for illumination. Best accuracy.
                  </p>
                  {selectedCamera === 'rear' && (
                    <div className="mt-1.5 text-green-400 text-[9px] font-mono font-bold">✓ RECOMMENDED</div>
                  )}
                </button>

                <button
                  onClick={() => setSelectedCamera('front')}
                  className={`p-3 rounded-xl border-2 text-left transition-all ${
                    selectedCamera === 'front'
                      ? 'border-blue-500 bg-blue-950/30'
                      : 'border-gray-800 bg-gray-900/80 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">🤳</span>
                    <span className={`font-mono text-sm font-bold ${selectedCamera === 'front' ? 'text-blue-400' : 'text-gray-400'}`}>
                      Front Camera
                    </span>
                  </div>
                  <p className="text-gray-500 text-[10px] font-mono leading-tight">
                    Screen acts as flash. Easier to use.
                  </p>
                  {selectedCamera === 'front' && (
                    <div className="mt-1.5 text-blue-400 text-[9px] font-mono font-bold">SCREEN FLASH MODE</div>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ===== FRONT CAMERA INSTRUCTIONS (while active) ===== */}
          {showScreenFlash && !data.fingerDetected && (
            <div className="px-4 pt-6 pb-4 text-center">
              <div className="text-6xl mb-3">☝️</div>
              <h2 className="text-gray-800 font-bold text-lg mb-2">Place your finger on the front camera</h2>
              <p className="text-gray-500 text-sm max-w-xs mx-auto">
                The bright white screen will shine through your finger. Cover the camera lens gently and hold still.
              </p>
            </div>
          )}

          {/* ===== BPM DISPLAY ===== */}
          <div className="px-4 pt-4 pb-3">
            <div className={`rounded-2xl border p-6 text-center relative overflow-hidden ${
              showScreenFlash
                ? 'bg-gray-900 border-gray-700'
                : 'bg-black border-gray-800/80'
            }`}>
              {/* Beat flash overlay */}
              <div
                className="absolute inset-0 bg-red-600 pointer-events-none transition-opacity"
                style={{ opacity: heartScale > 1.1 ? 0.06 : 0, transitionDuration: '80ms' }}
              />

              {/* Pulsing heart */}
              <div className="text-5xl mb-1 inline-block" style={{
                transform: `scale(${heartScale})`,
                transition: 'transform 0.1s ease-out',
                filter: data.bpm > 0 ? `drop-shadow(0 0 ${heartScale > 1.1 ? 15 : 5}px rgba(239,68,68,0.5))` : 'none',
              }}>
                {data.fingerDetected && isActive ? '❤️' : data.bpm > 0 && isActive ? '❤️' : '🤍'}
              </div>

              {/* BPM number — stays visible once established */}
              <div className="font-mono font-bold leading-none mt-1" style={{
                fontSize: data.bpm > 0 ? 'clamp(4rem, 15vw, 7rem)' : '4rem',
                transform: `scale(${heartScale > 1.1 ? 1.02 : 1})`,
                transition: 'transform 0.1s ease-out',
              }}>
                <span className={
                  data.bpm > 0
                    ? data.confidence > 30 ? 'text-red-500' : 'text-red-500/60'
                    : 'text-gray-700'
                }>
                  {data.bpm > 0 ? data.bpm : '—'}
                </span>
              </div>
              <div className="text-gray-500 font-mono text-sm mt-0.5">
                {data.bpm > 0 && data.confidence <= 20 && isActive
                  ? <span className="text-yellow-500/70">Last reading • Recalibrating...</span>
                  : 'BPM'
                }
              </div>

              {/* Zone */}
              {data.bpm > 0 && (
                <div className={`mt-3 inline-block px-4 py-1 rounded-full text-xs font-mono font-bold ${zone.color} ${zone.bg} border border-gray-800`}>
                  {zone.label}
                </div>
              )}

              {/* Confidence */}
              {data.status === 'measuring' && (
                <div className="mt-4 max-w-xs mx-auto">
                  <div className="flex justify-between text-[10px] font-mono text-gray-500 mb-1">
                    <span>Signal Quality</span>
                    <span>{data.confidence}%</span>
                  </div>
                  <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500" style={{
                      width: `${data.confidence}%`,
                      backgroundColor: data.confidence > 70 ? '#22c55e' : data.confidence > 40 ? '#eab308' : '#ef4444',
                    }} />
                  </div>
                </div>
              )}

              {/* Camera mode badge */}
              {isActive && (
                <div className="mt-3">
                  <span className={`text-[9px] font-mono px-2 py-0.5 rounded ${
                    isFrontCamera ? 'bg-blue-900/40 text-blue-400' : 'bg-gray-800 text-gray-500'
                  }`}>
                    {isFrontCamera ? '🤳 FRONT CAM + SCREEN FLASH' : '📸 REAR CAM + TORCH'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ===== STATUS ===== */}
          <div className="px-4 pb-2 text-center">
            <div className={`font-mono text-sm flex items-center justify-center gap-2 ${
              showScreenFlash ? 'text-gray-700' : getStatusColor()
            }`}>
              {(data.status === 'detecting' || data.status === 'measuring') && (
                <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${
                  data.status === 'measuring' ? 'bg-green-400' : 'bg-yellow-400'
                }`} />
              )}
              {getStatusText()}
            </div>
          </div>

          {/* ===== LIVE WAVEFORM ===== */}
          <div className="px-4 pb-3">
            {isActive && (
              <div className="flex items-center justify-between mb-1.5 px-1">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                    data.fingerDetected ? 'bg-red-500 animate-pulse' : 'bg-gray-600'
                  }`} />
                  <span className={`text-[10px] font-mono ${showScreenFlash ? 'text-gray-600' : 'text-gray-500'}`}>
                    LIVE PULSE WAVEFORM
                  </span>
                </div>
                <span className={`text-[10px] font-mono ${showScreenFlash ? 'text-gray-600' : 'text-gray-600'}`}>
                  {data.fingerDetected ? 'Each peak = one heartbeat' : 'Waiting for finger...'}
                </span>
              </div>
            )}
            <div className={`h-[180px] sm:h-[220px] rounded-xl overflow-hidden border ${
              showScreenFlash ? 'border-gray-700' : 'border-gray-800/80'
            }`}>
              <PPGWaveform data={data} />
            </div>
          </div>

          {/* ===== LIVE SENSOR STATUS ===== */}
          {isActive && (
            <div className="px-4 pb-3 space-y-2">
              {/* Blood flow signal — explained in plain English */}
              <div className={`rounded-xl border p-3 ${
                showScreenFlash ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/80 border-gray-800/60'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">🩸</span>
                    <span className={`font-mono text-xs font-bold ${data.fingerDetected ? 'text-red-400' : 'text-gray-500'}`}>
                      Blood Flow Signal
                    </span>
                  </div>
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                    data.avgRedLevel > 150 ? 'bg-green-900/40 text-green-400' :
                    data.avgRedLevel > 80 ? 'bg-yellow-900/40 text-yellow-400' :
                    'bg-gray-800 text-gray-500'
                  }`}>
                    {data.avgRedLevel > 150 ? 'STRONG' : data.avgRedLevel > 80 ? 'WEAK' : 'NONE'}
                  </span>
                </div>
                <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-300" style={{
                    width: `${(data.avgRedLevel / 255) * 100}%`,
                    background: data.fingerDetected
                      ? 'linear-gradient(90deg, #dc2626, #ef4444, #f87171)'
                      : '#4b5563',
                  }} />
                </div>
                <p className="text-gray-600 text-[10px] mt-1.5 leading-relaxed">
                  {data.fingerDetected
                    ? data.avgRedLevel > 150
                      ? 'Light is passing through your finger clearly — the camera can see your blood pulsing.'
                      : 'Signal detected but weak — try pressing your finger a bit more firmly on the camera.'
                    : isFrontCamera
                      ? 'Cover the front camera with your fingertip. The white screen light needs to pass through your finger.'
                      : 'Place your fingertip over the rear camera and flash. The light needs to shine through your finger.'
                  }
                </p>
              </div>

              {/* Finger + Beats row */}
              <div className="flex gap-2">
                <div className={`flex-1 rounded-xl border p-3 transition-all duration-300 ${
                  data.fingerDetected
                    ? 'bg-green-950/20 border-green-800/60'
                    : showScreenFlash ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/80 border-gray-800/60'
                }`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-xs">{data.fingerDetected ? '✅' : '👆'}</span>
                    <span className="text-gray-500 text-[9px] font-mono">FINGER</span>
                  </div>
                  <div className={`font-mono text-sm font-bold ${data.fingerDetected ? 'text-green-400' : 'text-gray-600'}`}>
                    {data.fingerDetected ? 'On Camera' : 'Not Found'}
                  </div>
                </div>

                <div className={`flex-1 rounded-xl border p-3 ${
                  showScreenFlash ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/80 border-gray-800/60'
                }`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-xs" style={{
                      transform: `scale(${heartScale > 1.1 ? 1.3 : 1})`,
                      transition: 'transform 0.1s',
                      display: 'inline-block',
                    }}>💓</span>
                    <span className="text-gray-500 text-[9px] font-mono">BEATS</span>
                  </div>
                  <div className="text-red-400 font-mono text-sm font-bold">{data.beatTimestamps.length} detected</div>
                </div>

                <div className={`flex-1 rounded-xl border p-3 ${
                  showScreenFlash ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/80 border-gray-800/60'
                }`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-xs">⏱️</span>
                    <span className="text-gray-500 text-[9px] font-mono">MONITORING</span>
                  </div>
                  <div className="text-cyan-400 font-mono text-sm font-bold">
                    <MonitorTimer isRunning={isActive && data.fingerDetected} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ===== STATS ===== */}
          {bpmHistory.length > 3 && (
            <div className="px-4 pb-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'AVG', value: avgBpm, color: 'text-white' },
                  { label: 'MIN', value: minBpm, color: 'text-blue-400' },
                  { label: 'MAX', value: maxBpm, color: 'text-red-400' },
                ].map(s => (
                  <div key={s.label} className={`rounded-xl border p-3 text-center ${
                    showScreenFlash ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/80 border-gray-800/60'
                  }`}>
                    <div className="text-gray-600 text-[9px] font-mono mb-1">{s.label}</div>
                    <div className={`font-mono text-lg font-bold ${s.color}`}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ===== START / STOP ===== */}
          <div className="px-4 pb-3">
            {!isActive && data.status !== 'starting' ? (
              <button
                onClick={handleStart}
                className={`w-full py-4 rounded-2xl font-bold text-lg transition-colors flex items-center justify-center gap-3 shadow-lg ${
                  selectedCamera === 'front'
                    ? 'bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white shadow-blue-900/30'
                    : 'bg-red-600 hover:bg-red-500 active:bg-red-700 text-white shadow-red-900/30'
                }`}
              >
                {selectedCamera === 'front' ? (
                  <span className="text-xl">🤳</span>
                ) : (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
                START — {selectedCamera === 'front' ? 'Front Camera' : 'Rear Camera'}
              </button>
            ) : data.status === 'starting' ? (
              <button disabled className="w-full py-4 rounded-2xl bg-gray-800 text-gray-500 font-bold text-lg flex items-center justify-center gap-3">
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Accessing Camera...
              </button>
            ) : (
              <button
                onClick={handleStop}
                className={`w-full py-4 rounded-2xl font-bold text-lg transition-colors border flex items-center justify-center gap-3 ${
                  showScreenFlash
                    ? 'bg-gray-900 hover:bg-gray-800 text-red-400 border-gray-700'
                    : 'bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-red-400 border-gray-700'
                }`}
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" /></svg>
                STOP MEASUREMENT
              </button>
            )}
          </div>

          {/* ===== BPM HISTORY ===== */}
          {bpmHistory.length > 5 && (
            <div className="px-4 pb-3">
              <div className={`rounded-xl border p-3 ${
                showScreenFlash ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/80 border-gray-800/60'
              }`}>
                <div className="text-gray-600 text-[9px] font-mono mb-2">BPM OVER TIME</div>
                <div className="flex items-end gap-[2px] h-12">
                  {bpmHistory.slice(-50).map((bpm, i, arr) => {
                    const lo = Math.min(...bpmHistory) - 5;
                    const hi = Math.max(...bpmHistory) + 5;
                    const pct = ((bpm - lo) / (hi - lo)) * 100;
                    return (
                      <div key={i} className="flex-1 rounded-t" style={{
                        height: `${Math.max(4, pct)}%`,
                        backgroundColor: bpm < 60 ? '#3b82f6' : bpm <= 100 ? '#22c55e' : bpm <= 140 ? '#eab308' : '#ef4444',
                        opacity: i === arr.length - 1 ? 1 : 0.3 + (i / arr.length) * 0.6,
                      }} />
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ===== INFO ===== */}
          <div className="px-4 pb-4">
            <button
              onClick={() => setShowInfo(!showInfo)}
              className={`w-full text-left rounded-xl border p-4 transition-colors ${
                showScreenFlash
                  ? 'bg-gray-900 border-gray-700 hover:border-gray-600'
                  : 'bg-gray-900/80 border-gray-800/60 hover:border-gray-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-gray-300 font-medium text-sm flex items-center gap-2">
                  📋 How to use
                </span>
                <svg className={`w-4 h-4 text-gray-500 transition-transform ${showInfo ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>

              {showInfo && (
                <div className="mt-4 space-y-3" onClick={e => e.stopPropagation()}>
                  {/* Rear camera instructions */}
                  <div className="p-3 bg-gray-800/60 rounded-lg border border-gray-700/50">
                    <p className="text-red-400 text-[10px] font-mono font-bold mb-2">📸 REAR CAMERA (Recommended)</p>
                    <ol className="text-gray-400 text-xs space-y-1 list-decimal list-inside">
                      <li>Select <strong className="text-gray-300">Rear Camera</strong> and tap Start</li>
                      <li>Place your <strong className="text-gray-300">fingertip over the rear camera + flash</strong></li>
                      <li>The flash illuminates your finger — hold still 10-15 seconds</li>
                      <li>Wait for signal quality {'>'}50% for best reading</li>
                    </ol>
                  </div>

                  {/* Front camera instructions */}
                  <div className="p-3 bg-gray-800/60 rounded-lg border border-gray-700/50">
                    <p className="text-blue-400 text-[10px] font-mono font-bold mb-2">🤳 FRONT CAMERA (Screen Flash)</p>
                    <ol className="text-gray-400 text-xs space-y-1 list-decimal list-inside">
                      <li>Select <strong className="text-gray-300">Front Camera</strong> and tap Start</li>
                      <li>The <strong className="text-gray-300">screen turns bright white</strong> to act as a flash</li>
                      <li>Place your <strong className="text-gray-300">fingertip over the front camera lens</strong></li>
                      <li>The white screen light shines through your finger</li>
                      <li>Hold still — may take slightly longer to stabilize</li>
                    </ol>
                  </div>

                  <div className="p-3 bg-yellow-950/20 border border-yellow-900/40 rounded-lg">
                    <p className="text-yellow-500 text-[10px] font-mono font-bold mb-1">⚠️ NOT A MEDICAL DEVICE</p>
                    <p className="text-yellow-200/50 text-xs leading-relaxed">
                      This uses photoplethysmography (PPG) via your phone camera to <em>estimate</em> heart rate.
                      Use a proper pulse oximeter for reliable medical readings.
                    </p>
                  </div>

                  <div className="p-3 bg-gray-800/40 border border-gray-700/50 rounded-lg">
                    <p className="text-gray-500 text-[10px] font-mono font-bold mb-1">💡 TIPS</p>
                    <ul className="text-gray-600 text-xs space-y-0.5">
                      <li>• <strong className="text-gray-400">Rear camera</strong> = more accurate (real flash)</li>
                      <li>• <strong className="text-gray-400">Front camera</strong> = easier to use (screen as flash)</li>
                      <li>• Warm hands work better than cold</li>
                      <li>• Don't press too hard — gentle contact</li>
                      <li>• Best on <strong className="text-gray-400">Chrome on Android</strong></li>
                    </ul>
                  </div>
                </div>
              )}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className={`px-4 py-2.5 border-t text-center ${
          showScreenFlash ? 'border-gray-700 bg-gray-900/90' : 'border-gray-800/40'
        }`}>
          <p className={`text-[9px] font-mono ${showScreenFlash ? 'text-gray-500' : 'text-gray-700'}`}>
            Camera PPG Heart Rate Estimation • Not a medical device
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
