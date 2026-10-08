/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Subtitles,
  Volume2,
  AlertCircle,
  Hand,
} from "lucide-react";
import {
  CoachVoiceAvatar,
  CallConnectionState,
} from "./components/CoachVoiceAvatar";
import {
  encodeFloat32ToBase64Pcm16,
  decodeBase64Pcm16ToFloat32,
  calculateRmsLevel,
} from "./utils/audioEngine";

const AVAILABLE_VOICES = [
  { id: "Zephyr", label: "Zephyr · Warm & Natural" },
  { id: "Kore", label: "Kore · Clear & Articulate" },
  { id: "Puck", label: "Puck · Lively & Friendly" },
  { id: "Charon", label: "Charon · Calm & Steady" },
  { id: "Fenrir", label: "Fenrir · Deep & Direct" },
];

export default function App() {
  const [connectionState, setConnectionState] =
    useState<CallConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string>("Zephyr");
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [isCoachSpeaking, setIsCoachSpeaking] = useState<boolean>(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState<boolean>(false);
  const [wasRecentlyInterrupted, setWasRecentlyInterrupted] =
    useState<boolean>(false);
  const [micLevel, setMicLevel] = useState<number>(0);
  const [coachLevel, setCoachLevel] = useState<number>(0);
  const [callDurationSeconds, setCallDurationSeconds] = useState<number>(0);

  const [showCaptions, setShowCaptions] = useState<boolean>(true);
  const [lastUserCaption, setLastUserCaption] = useState<string>("");
  const [lastCoachCaption, setLastCoachCaption] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const isCallActiveRef = useRef<boolean>(false);
  const isStartingCallRef = useRef<boolean>(false);
  const isMicMutedRef = useRef<boolean>(false);

  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);

  const outputGainRef = useRef<GainNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const scheduledSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const minAcceptedTurnIdRef = useRef<number>(1);
  const lastCompletedTurnIdRef = useRef<number>(0);

  const interruptionTimeoutRef = useRef<number | null>(null);
  const userSpeechTimeoutRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
    if (isMicMuted) {
      setMicLevel(0);
      setIsUserSpeaking(false);
    }
  }, [isMicMuted]);

  useEffect(() => {
    if (connectionState !== "connected") {
      setCallDurationSeconds(0);
      return;
    }
    const interval = window.setInterval(() => {
      setCallDurationSeconds((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [connectionState]);

  const stopAndClearCoachAudio = useCallback(() => {
    for (const source of scheduledSourcesRef.current) {
      try {
        source.onended = null;
        source.stop(0);
        source.disconnect();
      } catch {
        // Ignore
      }
    }
    scheduledSourcesRef.current.clear();

    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }

    setIsCoachSpeaking(false);
    setCoachLevel(0);
  }, []);

  const scheduleCoachAudioChunk = useCallback(
    (base64Audio: string, turnId?: number) => {
      if (!isCallActiveRef.current) return;

      if (
        typeof turnId === "number" &&
        turnId < minAcceptedTurnIdRef.current
      ) {
        return;
      }

      const ctx = outputAudioCtxRef.current;
      const outputGain = outputGainRef.current;
      if (!ctx || !outputGain) return;

      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      let float32: Float32Array;
      try {
        float32 = decodeBase64Pcm16ToFloat32(base64Audio);
      } catch {
        return;
      }
      if (float32.length === 0) return;

      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputGain);

      const now = ctx.currentTime;
      const startTime = Math.max(now + 0.008, nextStartTimeRef.current);
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      scheduledSourcesRef.current.add(source);
      setIsCoachSpeaking(true);

      source.onended = () => {
        scheduledSourcesRef.current.delete(source);
        if (scheduledSourcesRef.current.size === 0) {
          if (outputAudioCtxRef.current) {
            nextStartTimeRef.current = Math.min(
              nextStartTimeRef.current,
              outputAudioCtxRef.current.currentTime
            );
          }
          setIsCoachSpeaking(false);
          setCoachLevel(0);
        }
      };

      source.start(startTime);
    },
    []
  );

  useEffect(() => {
    const dataArray = new Uint8Array(128);

    const updateMeter = () => {
      const analyser = outputAnalyserRef.current;
      if (
        analyser &&
        isCallActiveRef.current &&
        scheduledSourcesRef.current.size > 0
      ) {
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        setCoachLevel(Math.min(1, rms * 4.5));
      } else {
        setCoachLevel(0);
      }
      animFrameRef.current = window.requestAnimationFrame(updateMeter);
    };

    animFrameRef.current = window.requestAnimationFrame(updateMeter);
    return () => {
      if (animFrameRef.current) {
        window.cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  const cleanupSession = useCallback(
    (nextState: CallConnectionState = "idle") => {
      isCallActiveRef.current = false;
      isStartingCallRef.current = false;

      if (interruptionTimeoutRef.current) {
        window.clearTimeout(interruptionTimeoutRef.current);
        interruptionTimeoutRef.current = null;
      }
      if (userSpeechTimeoutRef.current) {
        window.clearTimeout(userSpeechTimeoutRef.current);
        userSpeechTimeoutRef.current = null;
      }

      stopAndClearCoachAudio();

      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "end" }));
          }
          ws.close(1000, "User ended call");
        } catch {
          // Ignore
        }
      }

      if (scriptProcessorRef.current) {
        try {
          scriptProcessorRef.current.onaudioprocess = null;
          scriptProcessorRef.current.disconnect();
        } catch {
          // Ignore
        }
        scriptProcessorRef.current = null;
      }

      if (micSourceRef.current) {
        try {
          micSourceRef.current.disconnect();
        } catch {
          // Ignore
        }
        micSourceRef.current = null;
      }

      if (silentGainRef.current) {
        try {
          silentGainRef.current.disconnect();
        } catch {
          // Ignore
        }
        silentGainRef.current = null;
      }

      if (mediaStreamRef.current) {
        for (const track of mediaStreamRef.current.getTracks()) {
          try {
            track.stop();
          } catch {
            // Ignore
          }
        }
        mediaStreamRef.current = null;
      }

      if (inputAudioCtxRef.current) {
        try {
          inputAudioCtxRef.current.close().catch(() => {});
        } catch {
          // Ignore
        }
        inputAudioCtxRef.current = null;
      }

      if (outputAudioCtxRef.current) {
        try {
          outputAudioCtxRef.current.close().catch(() => {});
        } catch {
          // Ignore
        }
        outputAudioCtxRef.current = null;
        outputGainRef.current = null;
        outputAnalyserRef.current = null;
      }

      setIsCoachSpeaking(false);
      setIsUserSpeaking(false);
      setWasRecentlyInterrupted(false);
      setMicLevel(0);
      setCoachLevel(0);
      setIsMicMuted(false);
      setConnectionState(nextState);
    },
    [stopAndClearCoachAudio]
  );

  useEffect(() => {
    return () => {
      cleanupSession("idle");
    };
  }, [cleanupSession]);

  const handleStartCall = async () => {
    if (isCallActiveRef.current || isStartingCallRef.current) {
      return;
    }

    cleanupSession("requesting_mic");
    isStartingCallRef.current = true;
    setErrorMessage(null);
    setLastUserCaption("");
    setLastCoachCaption("");
    minAcceptedTurnIdRef.current = 1;
    lastCompletedTurnIdRef.current = 0;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          "Your browser does not support real-time microphone access."
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

      const inputCtx = new AudioCtx({ sampleRate: 16000 });
      const outputCtx = new AudioCtx({ sampleRate: 24000 });

      await Promise.all([
        inputCtx.state === "suspended" ? inputCtx.resume() : Promise.resolve(),
        outputCtx.state === "suspended" ? outputCtx.resume() : Promise.resolve(),
      ]);

      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const outputGain = outputCtx.createGain();
      outputGain.gain.value = 1.0;
      const outputAnalyser = outputCtx.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputGain.connect(outputAnalyser);
      outputAnalyser.connect(outputCtx.destination);

      outputGainRef.current = outputGain;
      outputAnalyserRef.current = outputAnalyser;

      setConnectionState("connecting");

      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProtocol}//${window.location.host}/api/live?voice=${encodeURIComponent(
        selectedVoice
      )}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (!isCallActiveRef.current && !isStartingCallRef.current) return;

        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "connected") {
          isStartingCallRef.current = false;
          isCallActiveRef.current = true;
          if (typeof msg.turnId === "number") {
            minAcceptedTurnIdRef.current = msg.turnId;
          }
          setConnectionState("connected");

          const source = inputCtx.createMediaStreamSource(stream);
          const processor = inputCtx.createScriptProcessor(2048, 1, 1);
          const silentGain = inputCtx.createGain();
          silentGain.gain.value = 0;

          micSourceRef.current = source;
          scriptProcessorRef.current = processor;
          silentGainRef.current = silentGain;

          source.connect(processor);
          processor.connect(silentGain);
          silentGain.connect(inputCtx.destination);

          processor.onaudioprocess = (audioEvent) => {
            if (
              !isCallActiveRef.current ||
              isMicMutedRef.current ||
              !wsRef.current ||
              wsRef.current.readyState !== WebSocket.OPEN
            ) {
              return;
            }

            const inputSamples = audioEvent.inputBuffer.getChannelData(0);
            const rms = calculateRmsLevel(inputSamples);
            setMicLevel(rms);

            if (rms > 0.08) {
              setIsUserSpeaking(true);
              if (userSpeechTimeoutRef.current) {
                window.clearTimeout(userSpeechTimeoutRef.current);
              }
              userSpeechTimeoutRef.current = window.setTimeout(() => {
                setIsUserSpeaking(false);
              }, 320);
            }

            const base64Audio = encodeFloat32ToBase64Pcm16(
              inputSamples,
              inputCtx.sampleRate,
              16000
            );

            try {
              wsRef.current.send(
                JSON.stringify({
                  type: "audio",
                  audio: base64Audio,
                })
              );
            } catch {
              // Ignore
            }
          };
        } else if (msg.type === "interrupted") {
          if (typeof msg.turnId === "number") {
            minAcceptedTurnIdRef.current = msg.turnId;
          } else {
            minAcceptedTurnIdRef.current += 1;
          }

          stopAndClearCoachAudio();
          setWasRecentlyInterrupted(true);

          if (interruptionTimeoutRef.current) {
            window.clearTimeout(interruptionTimeoutRef.current);
          }
          interruptionTimeoutRef.current = window.setTimeout(() => {
            setWasRecentlyInterrupted(false);
          }, 1600);
        } else if (msg.type === "audio" && typeof msg.audio === "string") {
          setWasRecentlyInterrupted(false);
          scheduleCoachAudioChunk(msg.audio, msg.turnId);
        } else if (
          msg.type === "input_transcription" &&
          typeof msg.text === "string"
        ) {
          setLastUserCaption((prev) => {
            const updated = (prev + msg.text).trim();
            return updated.length > 180 ? updated.slice(-180) : updated;
          });
        } else if (
          msg.type === "output_transcription" &&
          typeof msg.text === "string"
        ) {
          setLastCoachCaption((prev) => {
            const isNewTurn =
              typeof msg.turnId === "number" &&
              msg.turnId !== lastCompletedTurnIdRef.current;
            const base = isNewTurn ? prev : "";
            const updated = (base + msg.text).trim();
            return updated.length > 220 ? updated.slice(-220) : updated;
          });
        } else if (msg.type === "turn_complete") {
          if (typeof msg.turnId === "number") {
            lastCompletedTurnIdRef.current = msg.turnId;
          }
        } else if (msg.type === "error") {
          setErrorMessage(
            msg.message || "An error occurred during the Gemini Live session."
          );
          cleanupSession("error");
        } else if (msg.type === "session_closed") {
          if (isCallActiveRef.current) {
            cleanupSession("idle");
          }
        }
      };

      ws.onerror = () => {
        setErrorMessage(
          "Could not connect to the Gemini Live stream. Please try again."
        );
        cleanupSession("error");
      };

      ws.onclose = () => {
        if (isCallActiveRef.current || isStartingCallRef.current) {
          cleanupSession("idle");
        }
      };
    } catch (err: any) {
      const isPermissionDenied =
        err?.name === "NotAllowedError" ||
        err?.name === "PermissionDeniedError";
      setErrorMessage(
        isPermissionDenied
          ? "Microphone permission was denied. Please allow microphone access in your browser to start the call."
          : err?.message || "Failed to start call. Please check your microphone."
      );
      cleanupSession("error");
    }
  };

  const handleEndCall = () => {
    cleanupSession("idle");
  };

  const handleToggleMute = () => {
    if (connectionState !== "connected") return;
    setIsMicMuted((prev) => !prev);
  };

  const handlePromptCoachGreeting = () => {
    if (
      connectionState !== "connected" ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    setLastCoachCaption("");
    wsRef.current.send(
      JSON.stringify({
        type: "text",
        text: "Hello! Please greet me warmly like a friendly English conversation partner on a phone call and ask me an easy opening question to start our chat.",
      })
    );
  };

  const formatDuration = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const isConnected = connectionState === "connected";
  const isConnecting =
    connectionState === "requesting_mic" || connectionState === "connecting";

  const getConnectionStatusText = () => {
    switch (connectionState) {
      case "connected":
        return `Connected · Live (${formatDuration(callDurationSeconds)})`;
      case "requesting_mic":
        return "Requesting Mic Permission...";
      case "connecting":
        return "Connecting to Gemini Live...";
      case "error":
        return "Connection Error";
      default:
        return "Disconnected · Standby";
    }
  };

  const getMicrophoneStatusText = () => {
    if (connectionState === "requesting_mic") {
      return "Waiting for permission";
    }
    if (!isConnected) {
      return "Microphone Standby";
    }
    if (isMicMuted) {
      return "Microphone Muted";
    }
    if (isUserSpeaking) {
      return "Microphone Active · Receiving Speech";
    }
    return "Microphone On · Streaming 16kHz PCM";
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col justify-between">
      <header className="w-full max-w-md mx-auto px-5 pt-4 pb-3 flex items-center justify-between border-b border-slate-800/80">
        <a
          href="#top"
          onClick={(e) => e.preventDefault()}
          className="text-xl font-semibold tracking-tight text-white whitespace-nowrap"
        >
          English Coach Live
        </a>

        <div
          aria-live="polite"
          className="flex items-center gap-2 text-xs font-medium text-slate-300"
        >
          <span
            className={`w-2 h-2 rounded-full ${
              isConnected
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                : isConnecting
                ? "bg-sky-400 animate-ping"
                : connectionState === "error"
                ? "bg-rose-400"
                : "bg-slate-500"
            }`}
          />
          <span className="font-mono-tabular">{getConnectionStatusText()}</span>
        </div>
      </header>

      <main className="flex-1 w-full max-w-md mx-auto px-5 py-4 flex flex-col justify-between">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-slate-400 shrink-0" />
            <label htmlFor="voice-select" className="sr-only">
              Coach Voice
            </label>
            <select
              id="voice-select"
              disabled={isConnected || isConnecting}
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-2 text-xs font-medium text-slate-200 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50 min-h-[44px]"
            >
              {AVAILABLE_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => setShowCaptions((prev) => !prev)}
            className={`min-h-[44px] px-3.5 py-2 rounded-xl border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
              showCaptions
                ? "bg-slate-800/90 border-slate-700 text-slate-200"
                : "bg-slate-900/50 border-slate-800/80 text-slate-400 hover:text-slate-200"
            }`}
          >
            <Subtitles className="w-4 h-4" />
            <span>{showCaptions ? "Captions On" : "Captions Off"}</span>
          </button>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mt-3 p-3.5 rounded-2xl bg-rose-950/50 border border-rose-500/40 flex items-start gap-3 text-xs text-rose-200"
          >
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{errorMessage}</div>
          </div>
        )}

        <div className="my-auto flex flex-col items-center">
          <CoachVoiceAvatar
            connectionState={connectionState}
            isCoachSpeaking={isCoachSpeaking}
            isUserSpeaking={isUserSpeaking}
            isMicMuted={isMicMuted}
            wasRecentlyInterrupted={wasRecentlyInterrupted}
            micLevel={micLevel}
            coachLevel={coachLevel}
            voiceName={selectedVoice}
          />

          {isConnected && !isCoachSpeaking && !lastCoachCaption && (
            <button
              type="button"
              onClick={handlePromptCoachGreeting}
              className="mt-2 min-h-[44px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-emerald-300 flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <Hand className="w-3.5 h-3.5" />
              <span>Ask Coach to say hello first</span>
            </button>
          )}

          {showCaptions && (lastCoachCaption || lastUserCaption) && (
            <div className="mt-4 w-full px-4 py-3 rounded-2xl bg-slate-900/60 border border-slate-800/70 text-xs space-y-1.5">
              {lastUserCaption && (
                <p className="text-slate-400 truncate">
                  <span className="text-emerald-400 font-medium mr-1.5">
                    You:
                  </span>
                  {lastUserCaption}
                </p>
              )}
              {lastCoachCaption && (
                <p className="text-slate-200 line-clamp-2 leading-relaxed">
                  <span className="text-amber-300 font-medium mr-1.5">
                    Coach:
                  </span>
                  {lastCoachCaption}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="pt-3 pb-2 space-y-3">
          <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800/90 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                  !isConnected
                    ? "bg-slate-800 text-slate-400"
                    : isMicMuted
                    ? "bg-rose-500/20 text-rose-400"
                    : "bg-emerald-500/20 text-emerald-400"
                }`}
              >
                {isMicMuted ? (
                  <MicOff className="w-5 h-5" />
                ) : (
                  <Mic className="w-5 h-5" />
                )}
              </div>

              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-200 truncate">
                  {getMicrophoneStatusText()}
                </div>
                <div className="mt-1.5 w-36 sm:w-44 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    style={{
                      transform: `scaleX(${
                        isConnected && !isMicMuted
                          ? Math.max(0.04, micLevel).toFixed(2)
                          : 0
                      })`,
                    }}
                    className="h-full w-full bg-emerald-400 origin-left transition-transform duration-75"
                  />
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleToggleMute}
              disabled={!isConnected}
              className={`min-h-[44px] min-w-[88px] px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                !isConnected
                  ? "bg-slate-800/60 text-slate-500 cursor-not-allowed"
                  : isMicMuted
                  ? "bg-rose-500 text-white hover:bg-rose-400"
                  : "bg-slate-800 text-slate-200 hover:bg-slate-700"
              }`}
            >
              {isMicMuted ? "Unmute Mic" : "Mute Mic"}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={handleStartCall}
              disabled={isConnected || isConnecting}
              className={`min-h-[54px] px-4 py-3 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2.5 transition-transform active:scale-[0.98] whitespace-nowrap ${
                isConnected || isConnecting
                  ? "bg-slate-900 border border-slate-800 text-slate-600 cursor-not-allowed"
                  : "bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20"
              }`}
            >
              <Phone className="w-4 h-4 fill-current" />
              <span>Start Call</span>
            </button>

            <button
              type="button"
              onClick={handleEndCall}
              disabled={!isConnected && !isConnecting}
              className={`min-h-[54px] px-4 py-3 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2.5 transition-transform active:scale-[0.98] whitespace-nowrap ${
                !isConnected && !isConnecting
                  ? "bg-slate-900 border border-slate-800 text-slate-600 cursor-not-allowed"
                  : "bg-rose-500 hover:bg-rose-400 text-white shadow-lg shadow-rose-500/25"
              }`}
            >
              <PhoneOff className="w-4 h-4" />
              <span>End Call</span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
