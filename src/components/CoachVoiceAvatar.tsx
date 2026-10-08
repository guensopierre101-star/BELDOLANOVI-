import React from "react";
import { Mic, MicOff, Volume2, Radio, Sparkles } from "lucide-react";

export type CallConnectionState =
  | "idle"
  | "requesting_mic"
  | "connecting"
  | "connected"
  | "error";

interface CoachVoiceAvatarProps {
  connectionState: CallConnectionState;
  isCoachSpeaking: boolean;
  isUserSpeaking: boolean;
  isMicMuted: boolean;
  wasRecentlyInterrupted: boolean;
  micLevel: number;
  coachLevel: number;
  voiceName: string;
}

export const CoachVoiceAvatar: React.FC<CoachVoiceAvatarProps> = ({
  connectionState,
  isCoachSpeaking,
  isUserSpeaking,
  isMicMuted,
  wasRecentlyInterrupted,
  micLevel,
  coachLevel,
  voiceName,
}) => {
  const isConnected = connectionState === "connected";
  const isConnecting =
    connectionState === "requesting_mic" || connectionState === "connecting";

  const activeEnergy = isCoachSpeaking
    ? Math.max(0.15, coachLevel)
    : isUserSpeaking
    ? Math.max(0.12, micLevel)
    : 0;

  const outerRingScale = isConnected ? 1 + activeEnergy * 0.42 : 1;
  const midRingScale = isConnected ? 1 + activeEnergy * 0.25 : 1;
  const coreScale = isConnected ? 1 + activeEnergy * 0.12 : 1;

  const getPrimaryStateLabel = () => {
    if (connectionState === "requesting_mic") {
      return "Requesting Microphone Access...";
    }
    if (connectionState === "connecting") {
      return "Connecting to Gemini Live...";
    }
    if (connectionState === "error") {
      return "Connection Interrupted";
    }
    if (!isConnected) {
      return "Ready for Live Conversation";
    }
    if (wasRecentlyInterrupted) {
      return "Interrupted · Listening to you";
    }
    if (isCoachSpeaking) {
      return "Coach is speaking";
    }
    if (isMicMuted) {
      return "Microphone Muted";
    }
    if (isUserSpeaking) {
      return "Listening to you...";
    }
    return "Listening · Speak anytime";
  };

  const getSecondaryStateHint = () => {
    if (connectionState === "requesting_mic") {
      return "Please allow microphone access in your browser prompt";
    }
    if (connectionState === "connecting") {
      return "Opening low-latency native audio stream";
    }
    if (connectionState === "error") {
      return "Tap Start Call below to reconnect";
    }
    if (!isConnected) {
      return "Tap Start Call to begin your live English speaking session";
    }
    if (wasRecentlyInterrupted) {
      return "Coach stopped immediately — go ahead";
    }
    if (isCoachSpeaking) {
      return "Speak naturally at any time to interrupt";
    }
    if (isMicMuted) {
      return "Unmute your microphone to continue speaking";
    }
    return "Continuous bidirectional voice — no send button needed";
  };

  return (
    <div className="flex flex-col items-center justify-center py-4 select-none">
      <div className="relative flex items-center justify-center w-56 h-56 sm:w-64 sm:h-64">
        <div
          style={{
            transform: `scale(${outerRingScale.toFixed(3)})`,
            opacity: isConnected ? (isCoachSpeaking || isUserSpeaking ? 0.45 : 0.18) : 0.08,
          }}
          className={`absolute inset-2 rounded-full transition-transform duration-75 ease-out ${
            isCoachSpeaking
              ? "bg-amber-400/25 border border-amber-400/40"
              : isUserSpeaking
              ? "bg-emerald-400/25 border border-emerald-400/40"
              : "bg-slate-400/15 border border-slate-500/20"
          }`}
        />

        <div
          style={{
            transform: `scale(${midRingScale.toFixed(3)})`,
            opacity: isConnected ? (isCoachSpeaking || isUserSpeaking ? 0.65 : 0.28) : 0.12,
          }}
          className={`absolute inset-7 rounded-full transition-transform duration-75 ease-out ${
            isCoachSpeaking
              ? "bg-amber-500/20 border border-amber-300/50"
              : isUserSpeaking
              ? "bg-emerald-500/20 border border-emerald-300/50"
              : isConnecting
              ? "bg-sky-500/20 border border-sky-400/40 animate-pulse"
              : "bg-slate-700/30 border border-slate-600/30"
          }`}
        />

        <div
          style={{
            transform: `scale(${coreScale.toFixed(3)})`,
          }}
          className={`relative z-10 flex flex-col items-center justify-center w-36 h-36 sm:w-40 sm:h-40 rounded-full border transition-all duration-150 shadow-2xl ${
            isCoachSpeaking
              ? "bg-gradient-to-b from-amber-500/30 via-slate-900 to-slate-950 border-amber-400/60 shadow-amber-500/20"
              : isUserSpeaking
              ? "bg-gradient-to-b from-emerald-500/30 via-slate-900 to-slate-950 border-emerald-400/60 shadow-emerald-500/20"
              : isConnected
              ? "bg-gradient-to-b from-slate-800 via-slate-900 to-slate-950 border-emerald-500/40 shadow-emerald-950/30"
              : isConnecting
              ? "bg-gradient-to-b from-slate-800 via-slate-900 to-slate-950 border-sky-400/50"
              : "bg-gradient-to-b from-slate-800/90 via-slate-900 to-slate-950 border-slate-700/70"
          }`}
        >
          <div className="flex items-center justify-center gap-1.5 h-12 mb-1">
            {[0.45, 0.75, 1.0, 0.85, 0.55].map((multiplier, idx) => {
              const barLevel = isCoachSpeaking
                ? Math.max(0.22, Math.min(1, coachLevel * multiplier * 1.35))
                : isUserSpeaking
                ? Math.max(0.2, Math.min(1, micLevel * multiplier * 1.35))
                : isConnected
                ? 0.18
                : 0.12;

              return (
                <span
                  key={idx}
                  style={{
                    transform: `scaleY(${barLevel.toFixed(2)})`,
                  }}
                  className={`w-1.5 h-10 rounded-full origin-center transition-transform duration-75 ${
                    isCoachSpeaking
                      ? "bg-amber-300"
                      : isUserSpeaking
                      ? "bg-emerald-300"
                      : isConnected
                      ? "bg-emerald-400/60"
                      : isConnecting
                      ? "bg-sky-300/70 animate-pulse"
                      : "bg-slate-600"
                  }`}
                />
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-slate-300">
            {isCoachSpeaking ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-amber-300" />
                <span className="text-amber-200">{voiceName}</span>
              </>
            ) : isConnected && isMicMuted ? (
              <>
                <MicOff className="w-3.5 h-3.5 text-rose-400" />
                <span className="text-rose-300">Muted</span>
              </>
            ) : isConnected ? (
              <>
                <Mic className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-200">{voiceName}</span>
              </>
            ) : isConnecting ? (
              <>
                <Radio className="w-3.5 h-3.5 text-sky-400 animate-spin" />
                <span className="text-sky-200">Connecting</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-slate-400">Coach {voiceName}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 text-center px-4 max-w-sm">
        <p
          className={`text-lg sm:text-xl font-semibold tracking-tight transition-colors ${
            wasRecentlyInterrupted
              ? "text-emerald-300"
              : isCoachSpeaking
              ? "text-amber-200"
              : isConnected
              ? "text-white"
              : "text-slate-200"
          }`}
        >
          {getPrimaryStateLabel()}
        </p>
        <p className="mt-1 text-xs sm:text-sm text-slate-400 leading-relaxed">
          {getSecondaryStateHint()}
        </p>
      </div>
    </div>
  );
};
