import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

const VALID_VOICES = new Set(["Zephyr", "Kore", "Puck", "Charon", "Fenrir"]);

const ENGLISH_COACH_SYSTEM_INSTRUCTION = `You are a friendly, warm, and encouraging English conversation partner and teacher on a live phone call ("English Coach Live").

CORE CONVERSATION BEHAVIOR:
1. Speak natural, everyday spoken English at a clear, conversational pace.
2. Keep your responses reasonably short (1 to 3 sentences) so the conversation feels like a real, lively phone call rather than a lecture.
3. Ask natural follow-up questions and encourage the user to speak as much as possible.
4. The main goal is CONVERSATION: Do NOT turn every response into a grammar lesson. Keep the dialogue flowing naturally.
5. Natural mistake correction: If the user makes an important English mistake, correct it briefly and naturally in passing (e.g., "Oh, a quick tip—you can say '...'—and how did that go?") without breaking the conversational flow.
6. Clarification: If the user's English is difficult to understand or unclear, politely ask them to repeat or clarify what they meant.
7. Barge-in & interruption: If the user interrupts you while you are speaking, immediately yield and respond naturally to what they just said.`;

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
  return key.trim();
}

function createGeminiClient() {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error(
      "GEMINI_API_KEY is not configured. Please check your environment or secrets."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Enforce strictly ONE active Gemini Live session across the application
let activeClientSocket: WebSocket | null = null;
let activeCleanupFn: (() => void) | null = null;

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    const key = getApiKey();
    res.json({
      status: "ok",
      hasApiKey: Boolean(key && key !== "MY_GEMINI_API_KEY"),
    });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    try {
      const reqUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (reqUrl.pathname === "/api/live" || reqUrl.pathname === "/live") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (clientWs: WebSocket, request: http.IncomingMessage) => {
    // Immediately close any prior session so two Gemini Live sessions never coexist
    if (activeCleanupFn) {
      try {
        activeCleanupFn();
      } catch {
        // Ignore cleanup errors on previous session
      }
      activeCleanupFn = null;
    }
    if (activeClientSocket && activeClientSocket !== clientWs) {
      try {
        activeClientSocket.close(1000, "Replaced by new call session");
      } catch {
        // Ignore close errors
      }
    }
    activeClientSocket = clientWs;

    const reqUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const requestedVoice = reqUrl.searchParams.get("voice") || "Zephyr";
    const voiceName = VALID_VOICES.has(requestedVoice) ? requestedVoice : "Zephyr";

    let isClosed = false;
    let turnId = 1;

    const safeSend = (payload: Record<string, unknown>) => {
      if (!isClosed && clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(JSON.stringify(payload));
        } catch {
          // Ignore send errors if socket is closing
        }
      }
    };

    let sessionPromise: Promise<any> | null = null;

    const cleanupSession = () => {
      if (isClosed) return;
      isClosed = true;
      if (sessionPromise) {
        const currentPromise = sessionPromise;
        sessionPromise = null;
        currentPromise
          .then((session) => {
            try {
              session.close();
            } catch {
              // Ignore close error
            }
          })
          .catch(() => {
            // Ignore connection error during cleanup
          });
      }
      if (activeClientSocket === clientWs) {
        activeClientSocket = null;
        activeCleanupFn = null;
      }
    };

    activeCleanupFn = cleanupSession;

    try {
      const ai = createGeminiClient();

      sessionPromise = ai.live.connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: ENGLISH_COACH_SYSTEM_INSTRUCTION,
        },
        callbacks: {
          onopen: () => {
            if (isClosed) return;
            safeSend({
              type: "connected",
              voiceName,
              turnId,
            });
          },
          onmessage: (message: LiveServerMessage) => {
            if (isClosed) return;

            const serverContent = message.serverContent;
            if (!serverContent) return;

            // 1. Handle interruption FIRST and increment turnId so obsolete chunks are discarded
            if (serverContent.interrupted) {
              turnId += 1;
              safeSend({
                type: "interrupted",
                turnId,
              });
              return;
            }

            // 2. Forward native audio chunks from modelTurn parts
            const parts = serverContent.modelTurn?.parts;
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                const audioBase64 = part.inlineData?.data;
                if (audioBase64) {
                  safeSend({
                    type: "audio",
                    audio: audioBase64,
                    turnId,
                  });
                }
              }
            }

            // 3. Forward secondary transcriptions if present
            if (serverContent.inputTranscription?.text) {
              safeSend({
                type: "input_transcription",
                text: serverContent.inputTranscription.text,
                turnId,
              });
            }

            if (serverContent.outputTranscription?.text) {
              safeSend({
                type: "output_transcription",
                text: serverContent.outputTranscription.text,
                turnId,
              });
            }

            // 4. Forward turn completion notification
            if (serverContent.turnComplete) {
              safeSend({
                type: "turn_complete",
                turnId,
              });
            }
          },
          onerror: (err: any) => {
            if (isClosed) return;
            const errMessage =
              err?.message ||
              (typeof err === "string" ? err : "Gemini Live connection error occurred.");
            safeSend({
              type: "error",
              message: errMessage,
            });
          },
          onclose: () => {
            if (isClosed) return;
            safeSend({
              type: "session_closed",
            });
            cleanupSession();
          },
        },
      });

      sessionPromise
        .then((session) => {
          if (isClosed) {
            try {
              session.close();
            } catch {
              // Ignore
            }
          }
        })
        .catch((err: any) => {
          if (isClosed) return;
          safeSend({
            type: "error",
            message:
              err?.message ||
              "Failed to establish Gemini Live session. Please verify your GEMINI_API_KEY environment variable.",
          });
          cleanupSession();
          try {
            clientWs.close(1011, "Live session initialization failed");
          } catch {
            // Ignore
          }
        });
    } catch (err: any) {
      safeSend({
        type: "error",
        message: err?.message || "Failed to initialize Gemini Live client.",
      });
      cleanupSession();
      try {
        clientWs.close(1011, "Initialization error");
      } catch {
        // Ignore
      }
      return;
    }

    clientWs.on("message", (rawData) => {
      if (isClosed || !sessionPromise) return;

      try {
        const msg = JSON.parse(rawData.toString());

        if (msg.type === "audio" && typeof msg.audio === "string") {
          sessionPromise
            .then((session) => {
              if (isClosed) return;
              session.sendRealtimeInput({
                audio: {
                  data: msg.audio,
                  mimeType: "audio/pcm;rate=16000",
                },
              });
            })
            .catch(() => {
              // Ignore send errors if session closed
            });
        } else if (msg.type === "text" && typeof msg.text === "string") {
          sessionPromise
            .then((session) => {
              if (isClosed) return;
              session.sendRealtimeInput({
                text: msg.text,
              });
            })
            .catch(() => {
              // Ignore
            });
        } else if (msg.type === "end") {
          cleanupSession();
          try {
            clientWs.close(1000, "Client ended call");
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore malformed JSON frames
      }
    });

    clientWs.on("close", () => {
      cleanupSession();
    });

    clientWs.on("error", () => {
      cleanupSession();
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`English Coach Live server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
