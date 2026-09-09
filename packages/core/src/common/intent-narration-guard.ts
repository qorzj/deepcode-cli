import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const INTENT_NARRATION_LOG_FILE = "intent-narration.log";
const LOG_PREVIEW_LENGTH = 160;

export const DEFAULT_INTENT_NARRATION_PHRASES = [
  "let me run",
  "let me just",
  "let me execute",
  "let me add",
  "let me apply",
  "let me build",
  "let me check",
  "let me close",
  "let me commit",
  "let me continue",
  "let me create",
  "let me deploy",
  "let me edit",
  "let me fetch",
  "let me fix",
  "let me implement",
  "let me inspect",
  "let me install",
  "let me invoke",
  "let me mark",
  "let me merge",
  "let me open",
  "let me patch",
  "let me port",
  "let me proceed",
  "let me push",
  "let me read",
  "let me restart",
  "let me set up",
  "let me test",
  "let me update",
  "let me verify",
  "let me write",
  "I'll run it now",
  "I'll just run",
  "I'll just call",
  "running it now",
  "I'm going to run",
  "I will run it now",
  "doing it now",
  "executing now",
  "calling it now",
  "invoking now",
  "I'm running it",
  "for real",
  "no more loops",
] as const;

export const DEFAULT_INTENT_NARRATION_INSTRUCTION = "No prose intent. Emit the tool call now.";

export type IntentNarrationGuardSettings = {
  enabled?: boolean;
  phrases?: string[];
  additionalPhrases?: string[];
  instruction?: string;
  hardStopRejections?: number;
  hardStopWindow?: number;
};

export type ResolvedIntentNarrationGuardSettings = {
  enabled: boolean;
  phrases: string[];
  instruction: string;
  hardStopRejections: number;
  hardStopWindow: number;
};

export const DEFAULT_INTENT_NARRATION_GUARD_SETTINGS: ResolvedIntentNarrationGuardSettings = {
  enabled: true,
  phrases: [...DEFAULT_INTENT_NARRATION_PHRASES],
  instruction: DEFAULT_INTENT_NARRATION_INSTRUCTION,
  hardStopRejections: 4,
  hardStopWindow: 6,
};

export type IntentNarrationRejectionEvent = {
  timestamp: string;
  sessionId: string;
  stepId: string;
  matchedPhrase: string;
  textHash: string;
  textPreview: string;
  totalRejections: number;
  windowRejections: number;
  windowSize: number;
  hardStopped: boolean;
};

export function findIntentNarrationPhrase(
  content: string,
  hasToolCall: boolean,
  settings: ResolvedIntentNarrationGuardSettings
): string | null {
  if (!settings.enabled || hasToolCall) {
    return null;
  }

  const normalizedContent = normalizeForMatching(content);
  if (!normalizedContent) {
    return null;
  }

  for (const phrase of settings.phrases) {
    const normalizedPhrase = normalizeForMatching(phrase);
    if (normalizedPhrase && normalizedContent.includes(normalizedPhrase)) {
      return phrase;
    }
  }
  return null;
}

export function recordRejectionInWindow(history: boolean[], rejected: boolean, windowSize: number): boolean[] {
  const boundedWindow = Math.max(1, Math.floor(windowSize));
  return [...history, rejected].slice(-boundedWindow);
}

export function shouldHardStopIntentNarration(
  history: boolean[],
  settings: ResolvedIntentNarrationGuardSettings
): boolean {
  if (settings.hardStopRejections <= 0) {
    return false;
  }
  return history.filter(Boolean).length >= settings.hardStopRejections;
}

export function createIntentNarrationRejectionEvent(input: {
  content: string;
  sessionId: string;
  stepId: string;
  matchedPhrase: string;
  totalRejections: number;
  rejectionHistory: boolean[];
  windowSize: number;
  hardStopped: boolean;
}): IntentNarrationRejectionEvent {
  const normalizedPreview = input.content.replace(/\s+/g, " ").trim();
  return {
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    stepId: input.stepId,
    matchedPhrase: input.matchedPhrase,
    textHash: `sha256:${crypto.createHash("sha256").update(input.content).digest("hex")}`,
    textPreview:
      normalizedPreview.length > LOG_PREVIEW_LENGTH
        ? `${normalizedPreview.slice(0, LOG_PREVIEW_LENGTH)}…`
        : normalizedPreview,
    totalRejections: input.totalRejections,
    windowRejections: input.rejectionHistory.filter(Boolean).length,
    windowSize: input.windowSize,
    hardStopped: input.hardStopped,
  };
}

export function logIntentNarrationRejection(event: IntentNarrationRejectionEvent): void {
  try {
    const logPath = getIntentNarrationLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Guard diagnostics must never change agent-loop behavior.
  }
}

export function getIntentNarrationLogPath(): string {
  return path.join(os.homedir(), ".deepcode", "logs", INTENT_NARRATION_LOG_FILE);
}

function normalizeForMatching(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
