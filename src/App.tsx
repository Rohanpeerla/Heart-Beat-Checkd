import { useState, useEffect, useRef, useCallback } from 'react';
import { useHeartRateDetector } from './hooks/useHeartRateDetector';
import PPGWaveform from './components/PPGWaveform';

function App() {
  const { data, start, stop, videoRef, canvasRef } = useHeartRateDetector();
  const [bpmHistory, setBpmHistory] = useState<number[]>([]);
  const [showInfo, setShowInfo] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [heartScale, setHeartScale] = useState(1);
  const [prevLastBeat, setPrevLastBeat] = useState(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const t = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Track BPM history — only add when signal is stable
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

  // Beat animation + sound trigger
  useEffect(() => {
    if (data.lastBeatTime > 0 && data.lastBeatTime !== prevLastBeat) {
      setPrevLastBeat(data.lastBeatTime);

      // Heart pump animation
      setHeartScale(1.3);
      const t1 = setTimeout(() => setHeartScale(1.05), 120);
      const t2 = setTimeout(() => setHeartScale(1), 250);

      // Sound
      playBeat();

      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [data.lastBeatTime, prevLastBeat, playBeat]);

  const isActive = data.status === 'detecting' || data.status === 'measuring';
  const avgBpm = bpmHistory.length > 0
    ? Math.round(bpmHistory.reduce((a, b) => a + b, 0) / bpmHistory.length)
    : 0;
  const minBpm = bpmHistory.length > 0 ? Math.min(...bpmHistory) : 0;
  const maxBpm = bpmHistory.length > 0 ? Math.max(...bpmHistory) : 0;

  const getStatusText = () => {
    switch (data.status) {
      case 'idle': return 'Tap START to begin';
      case 'starting': return 'Accessing camera...';
      case 'detecting': return data.fingerDetected ? 'Analyzing signal — hold still...' : 'Place finger on the rear camera';
      case 'measuring': {
        if (data.confidence < 40) return 'Stabilizing — keep your finger still...';
        if (data.confidence < 65) return 'Measuring — signal improving...';
        return 'Reading your heartbeat ♥';
      }
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
    <div className="min-h-screen bg-gray-950 flex flex-col">

      {/* Hidden camera elements */}
      <video ref={videoRef} className="hidden" playsInline muted />
      <canvas ref={canvasRef} className="hidden" />

      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800/50 flex items-center justify-between bg-gray-900/60 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <span className="text-xl" style={{
            transform: `scale(${heartScale})`,
            transition: 'transform 0.1s ease-out',
            display: 'inline-block',
          }}>❤️</span>
          <div>
            <h1 className="text-white font-bold text-base leading-tight">Heart Rate Monitor</h1>
            <p className="text-gray-600 text-[9px] font-mono">Camera PPG • Estimate</p>
          </div>
        </div>
        <div className="text-gray-600 font-mono text-xs">
          {currentTime.toLocaleTimeString('en-US', { hour12: false })}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col max-w-2xl mx-auto w-full">

        {/* ===== BPM DISPLAY ===== */}
        <div className="px-4 pt-5 pb-3">
          <div className="bg-black rounded-2xl border border-gray-800/80 p-6 text-center relative overflow-hidden">

            {/* Beat flash overlay */}
            <div
              className="absolute inset-0 bg-red-600 pointer-events-none transition-opacity"
              style={{
                opacity: heartScale > 1.1 ? 0.06 : 0,
                transitionDuration: '80ms',
              }}
            />

            {/* Pulsing heart */}
            <div
              className="text-5xl mb-1 inline-block"
              style={{
                transform: `scale(${heartScale})`,
                transition: 'transform 0.1s ease-out',
                filter: data.bpm > 0 ? `drop-shadow(0 0 ${heartScale > 1.1 ? 15 : 5}px rgba(239,68,68,0.5))` : 'none',
              }}
            >
              {data.fingerDetected && isActive ? '❤️' : '🤍'}
            </div>

            {/* BPM number */}
            <div className="font-mono font-bold leading-none mt-1" style={{
              fontSize: data.bpm > 0 ? 'clamp(4rem, 15vw, 7rem)' : '4rem',
              transform: `scale(${heartScale > 1.1 ? 1.02 : 1})`,
              transition: 'transform 0.1s ease-out',
            }}>
              <span className={data.bpm > 0 ? 'text-red-500' : 'text-gray-700'}>
                {data.bpm > 0 ? data.bpm : '—'}
              </span>
            </div>
            <div className="text-gray-500 font-mono text-sm mt-0.5">BPM</div>

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
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${data.confidence}%`,
                      backgroundColor: data.confidence > 70 ? '#22c55e' : data.confidence > 40 ? '#eab308' : '#ef4444',
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ===== STATUS ===== */}
        <div className="px-4 pb-2 text-center">
          <div className={`font-mono text-sm flex items-center justify-center gap-2 ${getStatusColor()}`}>
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
          <div className="h-[180px] sm:h-[220px] rounded-xl overflow-hidden border border-gray-800/80">
            <PPGWaveform data={data} />
          </div>
        </div>

        {/* ===== SENSOR READOUT ===== */}
        {isActive && (
          <div className="px-4 pb-3">
            <div className="flex gap-2">
              {/* Red level */}
              <div className="flex-1 bg-gray-900/80 rounded-xl border border-gray-800/60 p-3">
                <div className="text-gray-600 text-[9px] font-mono mb-1">RED INTENSITY</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-red-400 font-mono text-xl font-bold">{Math.round(data.avgRedLevel)}</span>
                  <span className="text-gray-700 font-mono text-[10px]">/255</span>
                </div>
                <div className="mt-1.5 w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-200"
                    style={{
                      width: `${(data.avgRedLevel / 255) * 100}%`,
                      backgroundColor: data.fingerDetected ? '#ef4444' : '#4b5563',
                    }}
                  />
                </div>
              </div>

              {/* Finger */}
              <div className={`flex-1 rounded-xl border p-3 transition-all duration-300 ${
                data.fingerDetected
                  ? 'bg-green-950/20 border-green-800/60'
                  : 'bg-gray-900/80 border-gray-800/60'
              }`}>
                <div className="text-gray-600 text-[9px] font-mono mb-1">FINGER</div>
                <div className={`font-mono text-base font-bold ${data.fingerDetected ? 'text-green-400' : 'text-gray-600'}`}>
                  {data.fingerDetected ? '✓ Detected' : '✗ No finger'}
                </div>
                <div className="text-gray-700 text-[9px] font-mono mt-0.5">
                  {data.fingerDetected ? 'Hold still' : 'Cover camera'}
                </div>
              </div>

              {/* Beats counted */}
              <div className="flex-1 bg-gray-900/80 rounded-xl border border-gray-800/60 p-3">
                <div className="text-gray-600 text-[9px] font-mono mb-1">BEATS</div>
                <div className="text-red-400 font-mono text-xl font-bold">{data.beatTimestamps.length}</div>
                <div className="text-gray-700 text-[9px] font-mono mt-0.5">detected</div>
              </div>
            </div>
          </div>
        )}

        {/* ===== STATS ===== */}
        {bpmHistory.length > 3 && (
          <div className="px-4 pb-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-gray-900/80 rounded-xl border border-gray-800/60 p-3 text-center">
                <div className="text-gray-600 text-[9px] font-mono mb-1">AVG</div>
                <div className="text-white font-mono text-lg font-bold">{avgBpm}</div>
              </div>
              <div className="bg-gray-900/80 rounded-xl border border-gray-800/60 p-3 text-center">
                <div className="text-gray-600 text-[9px] font-mono mb-1">MIN</div>
                <div className="text-blue-400 font-mono text-lg font-bold">{minBpm}</div>
              </div>
              <div className="bg-gray-900/80 rounded-xl border border-gray-800/60 p-3 text-center">
                <div className="text-gray-600 text-[9px] font-mono mb-1">MAX</div>
                <div className="text-red-400 font-mono text-lg font-bold">{maxBpm}</div>
              </div>
            </div>
          </div>
        )}

        {/* ===== START / STOP ===== */}
        <div className="px-4 pb-3">
          {!isActive && data.status !== 'starting' ? (
            <button
              onClick={start}
              className="w-full py-4 rounded-2xl bg-red-600 hover:bg-red-500 active:bg-red-700 text-white font-bold text-lg transition-colors flex items-center justify-center gap-3 shadow-lg shadow-red-900/30"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              START MEASUREMENT
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
              onClick={() => { stop(); setBpmHistory([]); }}
              className="w-full py-4 rounded-2xl bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-red-400 font-bold text-lg transition-colors border border-gray-700 flex items-center justify-center gap-3"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" /></svg>
              STOP MEASUREMENT
            </button>
          )}
        </div>

        {/* ===== BPM HISTORY BAR CHART ===== */}
        {bpmHistory.length > 5 && (
          <div className="px-4 pb-3">
            <div className="bg-gray-900/80 border border-gray-800/60 rounded-xl p-3">
              <div className="text-gray-600 text-[9px] font-mono mb-2">BPM OVER TIME</div>
              <div className="flex items-end gap-[2px] h-12">
                {bpmHistory.slice(-50).map((bpm, i, arr) => {
                  const lo = Math.min(...bpmHistory) - 5;
                  const hi = Math.max(...bpmHistory) + 5;
                  const pct = ((bpm - lo) / (hi - lo)) * 100;
                  const isLast = i === arr.length - 1;
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-t"
                      style={{
                        height: `${Math.max(4, pct)}%`,
                        backgroundColor: bpm < 60 ? '#3b82f6' : bpm <= 100 ? '#22c55e' : bpm <= 140 ? '#eab308' : '#ef4444',
                        opacity: isLast ? 1 : 0.3 + (i / arr.length) * 0.6,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ===== INFO ACCORDION ===== */}
        <div className="px-4 pb-4">
          <button
            onClick={() => setShowInfo(!showInfo)}
            className="w-full text-left bg-gray-900/80 border border-gray-800/60 rounded-xl p-4 transition-colors hover:border-gray-700"
          >
            <div className="flex items-center justify-between">
              <span className="text-gray-300 font-medium text-sm flex items-center gap-2">
                <span>📋</span> How to use
              </span>
              <svg className={`w-4 h-4 text-gray-500 transition-transform ${showInfo ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>

            {showInfo && (
              <div className="mt-4 space-y-3" onClick={e => e.stopPropagation()}>
                {[
                  { step: '1', title: 'Tap "Start Measurement"', desc: 'Allow camera access when prompted' },
                  { step: '2', title: 'Cover the rear camera + flash with your fingertip', desc: 'Gently press — the screen should turn reddish' },
                  { step: '3', title: 'Hold still for 10-15 seconds', desc: 'You\'ll see the waveform start pulsing and hear beeps on each beat' },
                  { step: '4', title: 'Read your BPM', desc: 'Wait for signal quality > 50% for best accuracy' },
                ].map(item => (
                  <div key={item.step} className="flex gap-3">
                    <div className="w-6 h-6 rounded-full bg-red-900/50 border border-red-800 flex items-center justify-center text-red-400 font-bold text-[10px] shrink-0">{item.step}</div>
                    <div>
                      <p className="text-gray-300 text-sm font-medium">{item.title}</p>
                      <p className="text-gray-600 text-xs">{item.desc}</p>
                    </div>
                  </div>
                ))}

                <div className="mt-3 p-3 bg-yellow-950/20 border border-yellow-900/40 rounded-lg">
                  <p className="text-yellow-500 text-[10px] font-mono font-bold mb-1">⚠️ NOT A MEDICAL DEVICE</p>
                  <p className="text-yellow-200/50 text-xs leading-relaxed">
                    This uses photoplethysmography (PPG) via your phone camera to <em>estimate</em> heart rate.
                    It is not accurate enough for medical decisions. Use a proper pulse oximeter for reliable readings.
                  </p>
                </div>

                <div className="p-3 bg-gray-800/40 border border-gray-700/50 rounded-lg">
                  <p className="text-gray-500 text-[10px] font-mono font-bold mb-1">💡 TIPS</p>
                  <ul className="text-gray-600 text-xs space-y-0.5">
                    <li>• Best on <strong className="text-gray-400">Chrome on Android</strong></li>
                    <li>• Warm hands work better than cold</li>
                    <li>• Don't press too hard on the lens</li>
                    <li>• Sit still — movement adds noise</li>
                  </ul>
                </div>
              </div>
            )}
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-gray-800/40 text-center">
        <p className="text-gray-700 text-[9px] font-mono">
          Camera PPG Heart Rate Estimation • Not a medical device
        </p>
      </div>
    </div>
  );
}

export default App;
