import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "url";
import matter from "gray-matter";
import ejs from "ejs";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { launchNotifyScript } from "./common/notify";
import { buildThinkingRequestOptions } from "./common/openai-thinking";
import { readTextFileWithMetadata } from "./common/file-utils";
import {
  buildSkillCatalogPrompt,
  buildSkillDocumentsPrompt,
  getCompactPrompt,
  getExtensionRoot,
  getPlanModePrompt,
  getRuntimeContext,
  getSystemPrompt,
  getTools,
  type ToolDefinition,
} from "./prompt";
import {
  ToolExecutor,
  type CreateOpenAIClient,
  type ProcessTimeoutControl,
  type ProcessTimeoutInfo,
  type PluginRateLimitedTool,
  type SharpLoader,
  type ToolCallExecution,
  type ToolExecutionHooks,
  type ToolExecutionFollowUpMessage,
  type ToolExecutionResult,
} from "./tools/executor";
import { McpManager } from "./mcp/mcp-manager";
import {
  DEFAULT_FILE_EXPIRES_AFTER_SECONDS,
  DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
  DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
  DEFAULT_FILES_API_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_FILES_BYTES,
  getDefaultAutoCompactWindow,
  type McpServerConfig,
  type PermissionScope,
  type PermissionSettings,
} from "./settings";
import { logApiError } from "./common/error-logger";
import { logOpenAIChatCompletionDebug, normalizeDebugError } from "./common/debug-logger";
import {
  DEFAULT_INTENT_NARRATION_GUARD_SETTINGS,
  createIntentNarrationRejectionEvent,
  findIntentNarrationPhrase,
  logIntentNarrationRejection,
  recordRejectionInWindow,
  shouldHardStopIntentNarration,
  type IntentNarrationRejectionEvent,
  type ResolvedIntentNarrationGuardSettings,
} from "./common/intent-narration-guard";
import { describeLlmError, getLlmErrorDetails } from "./common/llm-error";
import { killProcessTree } from "./common/process-tree";
import { GitFileHistory, type FileHistoryCheckpointResult } from "./common/file-history";
import { clearSessionState, getSnippet, rebuildSessionStateFromHistory } from "./common/state";
import {
  appendProjectPermissionAllows,
  buildPermissionToolExecution,
  computeToolCallPermissions,
  hasUserPermissionReplies,
  normalizeAskPermissions,
  parseToolCallForPermissions,
  type AskPermissionRequest,
  type MessageToolPermission,
  type PermissionToolCall,
  type UserToolPermission,
} from "./common/permissions";
import { clearSessionWorkingDir } from "./tools/bash-handler";
import { reportNewPrompt } from "./common/telemetry";
import { OpenAIMessageConverter } from "./common/openai-message-converter";
import { supportsMultimodal, type MultimodalMode } from "./common/model-capabilities";
import {
  decodeDeepSeekImageDataUrl,
  DeepSeekFileStore,
  type DeepSeekFileReference,
  type DeepSeekFilesPolicy,
} from "./common/deepseek-files";
import { loadImageFile } from "./tools/image-file";
import {
  getLlmRetryDelayMs,
  getLlmRetryAfterMs,
  isRetryableLlmError,
  LLM_STREAM_FIRST_CHUNK_TIMEOUT_MS,
  LLM_STREAM_IDLE_TIMEOUT_MS,
  LlmStreamDisconnectedError,
  LlmStreamFirstChunkTimeoutError,
  LlmStreamIdleTimeoutError,
  MAX_LLM_RETRIES,
  waitForLlmRetry,
} from "./common/llm-retry";

export type { PermissionScope } from "./settings";
export type {
  AskPermissionRequest,
  AskPermissionScope,
  BashPermissionScope,
  MessageToolPermission,
  PermissionDecision,
  UserToolPermission,
} from "./common/permissions";

const MAX_SESSION_ENTRIES = 50;
const MAX_PROJECT_CODE_LENGTH = 64;
const PROJECT_CODE_HASH_LENGTH = 16;
const BACKGROUND_FAILURE_LOG_TAIL_CHARS = 4000;
const PLAN_MODE_ON_STATUS_MESSAGE = "  └ Set Plan Mode on. Awaiting <proposed_plan>.";
const PLAN_MODE_OFF_STATUS_MESSAGE = "  └ Set Plan Mode off.";
const PLAN_MODE_FORCE_ASK_SCOPES = [
  "write-in-cwd",
  "write-out-cwd",
  "delete-in-cwd",
  "delete-out-cwd",
  "mutate-git-log",
] as const satisfies readonly PermissionScope[];

type ChatCompletionDebugOptions = {
  enabled?: boolean;
  location: string;
  baseURL?: string;
  params?: Record<string, unknown>;
};

export function getCompactPromptTokenThreshold(model: string): number {
  return getDefaultAutoCompactWindow(model);
}

// Keep project storage paths short enough for Git's internal files on Windows.
export function getProjectCode(projectRoot: string): string {
  const legacyCode = getLegacyProjectCode(projectRoot);
  if (legacyCode.length <= MAX_PROJECT_CODE_LENGTH) {
    return legacyCode;
  }

  const normalizedRoot = path.resolve(projectRoot);
  const hashInput = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const hash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, PROJECT_CODE_HASH_LENGTH);
  const prefixLimit = MAX_PROJECT_CODE_LENGTH - PROJECT_CODE_HASH_LENGTH - 1;
  const basename = path.basename(normalizedRoot);
  const prefix =
    sanitizeProjectCodePart(basename)
      .slice(0, prefixLimit)
      .replace(/[-.]+$/g, "") || "project";
  return `${prefix}-${hash}`;
}

function getLegacyProjectCode(projectRoot: string): string {
  return projectRoot.replace(/[\\/]/g, "-").replace(/:/g, "");
}

function sanitizeProjectCodePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function replaceStringValues(value: unknown, search: string, replacement: string): unknown {
  if (typeof value === "string") {
    return value.split(search).join(replacement);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStringValues(item, search, replacement));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceStringValues(item, search, replacement)])
    );
  }
  return value;
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeCompletionOptions(options?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...options,
    signal: options.signal instanceof AbortSignal ? { aborted: options.signal.aborted } : options.signal,
  };
}

function addUsageValue(current: unknown, next: unknown): unknown {
  if (typeof next === "number") {
    return (typeof current === "number" ? current : 0) + next;
  }

  if (isUsageRecord(next)) {
    const currentRecord = isUsageRecord(current) ? current : {};
    const result: Record<string, unknown> = { ...currentRecord };
    for (const [key, value] of Object.entries(next)) {
      result[key] = addUsageValue(currentRecord[key], value);
    }
    return result;
  }

  return next;
}

function accumulateUsage(current: ModelUsage | null, next: unknown | null | undefined): ModelUsage | null {
  if (next == null) {
    return current ?? null;
  }
  return addUsageValue(current, next) as ModelUsage;
}

function usageWithRequestCount(usage: ModelUsage): ModelUsage {
  const totalReqs = typeof usage.total_reqs === "number" ? usage.total_reqs + 1 : 1;
  return {
    ...usage,
    total_reqs: totalReqs,
  };
}

function accumulateUsagePerModel(
  current: Record<string, ModelUsage> | null | undefined,
  model: string,
  next: ModelUsage | null | undefined
): Record<string, ModelUsage> | null {
  if (next == null) {
    return current ?? null;
  }

  const usagePerModel = { ...(current ?? {}) };
  const modelName = model.trim() || "unknown";
  usagePerModel[modelName] = accumulateUsage(usagePerModel[modelName] ?? null, usageWithRequestCount(next))!;
  return usagePerModel;
}

function getTotalTokens(usage: ModelUsage | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const totalTokens = usage.total_tokens;
  return typeof totalTokens === "number" ? totalTokens : 0;
}

export type SessionStatus =
  | "failed"
  | "pending"
  | "processing"
  | "waiting_for_user"
  | "completed"
  | "interrupted"
  | "ask_permission"
  | "permission_denied";

export type ModelUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: Record<string, unknown>;
  prompt_tokens_details?: Record<string, unknown>;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  total_reqs?: number;
};

export type SessionProcessEntry = {
  startTime: string;
  command: string;
  timeoutMs?: number;
  deadlineAt?: string;
  timedOut?: boolean;
};

export type BashTimeoutAdjustment = {
  processId: string;
  timeoutMs: number;
  deadlineAt: string;
  timedOut: boolean;
};

export type SessionEntry = {
  id: string;
  summary: string | null;
  assistantReply: string | null;
  assistantThinking: string | null;
  assistantRefusal: string | null;
  toolCalls: unknown[] | null;
  status: SessionStatus;
  failReason: string | null;
  usage: ModelUsage | null;
  usagePerModel: Record<string, ModelUsage> | null;
  activeTokens: number;
  createTime: string;
  updateTime: string;
  processes: Map<string, SessionProcessEntry> | null; // {pid: process info}
  askPermissions?: AskPermissionRequest[];
  planMode?: boolean;
  pluginRateLimitedTool?: PluginRateLimitedTool;
  intentNarrationRejections?: number;
  forkedFrom?: {
    sessionId: string;
    messageId: string;
  };
};

export type SessionsIndex = {
  version: 1;
  entries: SessionEntry[];
  originalPath: string;
};

export type SessionMessageRole = "system" | "user" | "assistant" | "tool";

export type MessageMeta = {
  function?: unknown;
  paramsMd?: string;
  resultMd?: string;
  asThinking?: boolean;
  isAnswers?: boolean;
  isSummary?: boolean;
  isModelChange?: boolean;
  skill?: SkillInfo;
  skillCatalog?: Array<{ name: string; description: string }>;
  permissions?: MessageToolPermission[];
  userPrompt?: UserPromptContent;
};

export type SessionMessage = {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  content: string | null;
  contentParams: unknown | null;
  messageParams: unknown | null;
  compacted: boolean;
  visible: boolean;
  createTime: string;
  updateTime: string;
  meta?: MessageMeta;
  html?: string;
  checkpointHash?: string;
};

export type UndoTarget = {
  message: SessionMessage;
  index: number;
  canRestoreCode: boolean;
};

export type UserPromptContent = {
  text?: string;
  imageUrls?: string[];
  skills?: SkillInfo[];
  permissions?: UserToolPermission[];
  alwaysAllows?: PermissionScope[];
  planMode?: boolean;
  isAnswers?: boolean;
};

type PersistedPromptImage = {
  buffer: Buffer;
  extension: ".gif" | ".jpg" | ".png" | ".webp";
};

export type SkillInfo = {
  name: string;
  path: string;
  description: string;
  isLoaded?: boolean;
  allowImplicitInvocation?: boolean;
};

export type SessionManagerOptions = {
  projectRoot: string;
  createOpenAIClient: CreateOpenAIClient;
  getResolvedSettings: () => {
    model: string;
    multimodal?: MultimodalMode;
    filesApiEnabled?: boolean;
    filesApiTimeoutMs?: number;
    fileExpiresAfterSeconds?: number;
    fileRefreshMarginSeconds?: number;
    fileQuotaCleanupBatch?: number;
    maxRequestFilesBytes?: number;
    contextWindow?: number;
    autoCompactWindow?: number;
    webSearchTool?: string;
    mcpServers?: Record<string, McpServerConfig>;
    permissions?: Required<PermissionSettings>;
    enabledSkills?: Record<string, boolean>;
    intentNarrationGuard?: ResolvedIntentNarrationGuardSettings;
  };
  renderMarkdown: (text: string) => string;
  onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  onSessionEntryUpdated?: (entry: SessionEntry) => void;
  onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
  onLlmRetry?: (event: LlmRetryEvent) => void;
  onIntentNarrationRejected?: (event: IntentNarrationRejectionEvent) => void;
  onMcpStatusChanged?: () => void;
  onProcessStdout?: (pid: number, chunk: string) => void;
  loadSharp?: SharpLoader;
  nonInteractive?: boolean;
};

export type LlmStreamProgress = {
  requestId: string;
  sessionId?: string;
  startedAt: string;
  estimatedTokens: number;
  formattedTokens: string;
  previewText?: string;
  phase: "start" | "update" | "end";
};

export type LlmRetryEvent = {
  requestId: string;
  sessionId?: string;
  error: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
};

export class SessionManager {
  private readonly projectRoot: string;
  private readonly createOpenAIClient: CreateOpenAIClient;
  private readonly getResolvedSettings: () => {
    model: string;
    multimodal?: MultimodalMode;
    filesApiEnabled?: boolean;
    filesApiTimeoutMs?: number;
    fileExpiresAfterSeconds?: number;
    fileRefreshMarginSeconds?: number;
    fileQuotaCleanupBatch?: number;
    maxRequestFilesBytes?: number;
    contextWindow?: number;
    autoCompactWindow?: number;
    webSearchTool?: string;
    mcpServers?: Record<string, McpServerConfig>;
    permissions?: Required<PermissionSettings>;
    enabledSkills?: Record<string, boolean>;
    intentNarrationGuard?: ResolvedIntentNarrationGuardSettings;
  };
  private readonly onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  private readonly onSessionEntryUpdated?: (entry: SessionEntry) => void;
  private readonly onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
  private readonly onLlmRetry?: (event: LlmRetryEvent) => void;
  private readonly onIntentNarrationRejected?: (event: IntentNarrationRejectionEvent) => void;
  private readonly onMcpStatusChanged?: () => void;
  private readonly onProcessStdout?: (pid: number, chunk: string) => void;
  private readonly nonInteractive: boolean;
  private activeSessionId: string | null = null;
  private activePromptController: AbortController | null = null;
  private readonly sessionControllers = new Map<string, AbortController>();
  private readonly processTimeoutControls = new Map<string, ProcessTimeoutControl>();
  private readonly liveProcessKeys = new Set<string>();
  private readonly toolExecutor: ToolExecutor;
  private readonly loadSharp?: SharpLoader;
  private readonly mcpManager = new McpManager();
  private mcpToolDefinitions: ToolDefinition[] = [];
  private readonly messageConverter: OpenAIMessageConverter;
  private readonly deepSeekFiles = new DeepSeekFileStore();

  constructor(options: SessionManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.createOpenAIClient = options.createOpenAIClient;
    this.getResolvedSettings = options.getResolvedSettings;
    this.onAssistantMessage = options.onAssistantMessage;
    this.onSessionEntryUpdated = options.onSessionEntryUpdated;
    this.onLlmStreamProgress = options.onLlmStreamProgress;
    this.onLlmRetry = options.onLlmRetry;
    this.onIntentNarrationRejected = options.onIntentNarrationRejected;
    this.onMcpStatusChanged = options.onMcpStatusChanged;
    this.onProcessStdout = options.onProcessStdout;
    this.nonInteractive = options.nonInteractive === true;
    this.loadSharp = options.loadSharp;
    this.toolExecutor = new ToolExecutor(this.projectRoot, this.createOpenAIClient, this.mcpManager, options.loadSharp);
    this.mcpManager.prepare(this.getResolvedSettings().mcpServers);
    this.messageConverter = new OpenAIMessageConverter({
      renderInitPrompt: () => this.renderInitCommandPrompt(),
    });
  }

  /**
   * @deprecated Use messageConverter.buildMessages directly.
   * Kept for test compatibility.
   */
  buildOpenAIMessages(
    messages: SessionMessage[],
    thinkingEnabled: boolean,
    model: string,
    multimodal?: MultimodalMode
  ): ChatCompletionMessageParam[] {
    return this.messageConverter.buildMessages(messages, thinkingEnabled, model, multimodal);
  }

  async initMcpServers(servers?: Record<string, McpServerConfig>): Promise<void> {
    this.mcpManager.setOnToolsListChanged(() => {
      this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
    });
    // 设置状态变更回调，通知 UI 更新
    this.mcpManager.setOnStatusChanged(() => {
      this.onMcpStatusChanged?.();
    });
    await this.mcpManager.initialize(servers);
    this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
  }

  getMcpStatus() {
    return this.mcpManager.getStatus();
  }

  async reconnectMcpServer(name: string, config?: McpServerConfig): Promise<void> {
    await this.mcpManager.reconnect(name, config);
    this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
  }

  dispose(): void {
    const controller = this.activePromptController;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    this.activePromptController = null;
    for (const sessionController of this.sessionControllers.values()) {
      if (!sessionController.signal.aborted) {
        sessionController.abort();
      }
    }
    this.killLiveProcesses();
    this.sessionControllers.clear();
    this.processTimeoutControls.clear();
    this.mcpManager.disconnect();
  }

  private estimateStreamTokens(text: string): number {
    let tokens = 0;
    for (const char of text) {
      tokens += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 0.6 : 0.3;
    }
    return tokens;
  }

  private formatEstimatedTokens(tokens: number): string {
    if (tokens <= 0) {
      return "0";
    }

    const roundedTokens = Math.round(tokens);
    if (roundedTokens <= 0) {
      return "0";
    }

    if (roundedTokens < 100) {
      return String(roundedTokens);
    }

    if (roundedTokens < 10000) {
      return `${Number((roundedTokens / 1000).toFixed(1))}k`;
    }

    return `${Math.round(roundedTokens / 1000)}k`;
  }

  private formatStreamPreview(text?: string): string | undefined {
    if (text === undefined) {
      return undefined;
    }

    return stripVTControlCharacters(text)
      .replace(/\r\n|[\r\n\t\u2028\u2029]/g, " ")
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  }

  private emitLlmStreamProgress(
    requestId: string,
    startedAt: string,
    estimatedTokens: number,
    phase: LlmStreamProgress["phase"],
    sessionId?: string,
    previewText?: string
  ): void {
    this.onLlmStreamProgress?.({
      requestId,
      sessionId,
      startedAt,
      estimatedTokens: Math.round(estimatedTokens),
      formattedTokens: this.formatEstimatedTokens(estimatedTokens),
      previewText: this.formatStreamPreview(previewText),
      phase,
    });
  }

  private isAbortLikeError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name === "AbortError" || error.constructor.name === "APIUserAbortError";
  }

  private throwIfAborted(signal?: AbortSignal | null): void {
    if (!signal?.aborted) {
      return;
    }

    const error = new Error("Request was aborted.");
    error.name = "AbortError";
    throw error;
  }

  private getDeepSeekFilesSettings(): {
    enabled: boolean;
    maxRequestFilesBytes: number;
    policy: DeepSeekFilesPolicy;
  } {
    const settings = this.getResolvedSettings();
    return {
      enabled: settings.filesApiEnabled === true,
      maxRequestFilesBytes: settings.maxRequestFilesBytes ?? DEFAULT_MAX_REQUEST_FILES_BYTES,
      policy: {
        timeoutMs: settings.filesApiTimeoutMs ?? DEFAULT_FILES_API_TIMEOUT_MS,
        expiresAfterSeconds: settings.fileExpiresAfterSeconds ?? DEFAULT_FILE_EXPIRES_AFTER_SECONDS,
        refreshMarginSeconds: settings.fileRefreshMarginSeconds ?? DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
        quotaCleanupBatch: settings.fileQuotaCleanupBatch ?? DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
      },
    };
  }

  private async buildMessagesWithDeepSeekFiles(
    messages: SessionMessage[],
    thinkingEnabled: boolean,
    model: string,
    apiKey: string,
    signal: AbortSignal
  ): Promise<{ messages: ChatCompletionMessageParam[]; references: DeepSeekFileReference[] }> {
    const settings = this.getDeepSeekFilesSettings();
    const converted = this.messageConverter.buildMessages(messages, thinkingEnabled, model, "on");
    const images: Array<{
      messageIndex: number;
      contentIndex: number;
      image: ReturnType<typeof decodeDeepSeekImageDataUrl>;
    }> = [];
    let totalBytes = 0;
    const uniqueImages = new Map<string, ReturnType<typeof decodeDeepSeekImageDataUrl>>();

    for (let messageIndex = 0; messageIndex < converted.length; messageIndex += 1) {
      const content = (converted[messageIndex] as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
        const part = content[contentIndex] as { type?: unknown; image_url?: { url?: unknown } };
        if (part.type !== "image_url" || typeof part.image_url?.url !== "string") {
          continue;
        }
        const image = decodeDeepSeekImageDataUrl(part.image_url.url, images.length);
        if (!uniqueImages.has(image.hash)) {
          totalBytes += image.buffer.byteLength;
          if (totalBytes > settings.maxRequestFilesBytes) {
            throw new Error(
              `Images in this request exceed the configured ${settings.maxRequestFilesBytes}-byte Files API limit.`
            );
          }
          uniqueImages.set(image.hash, image);
        }
        images.push({ messageIndex, contentIndex, image });
      }
    }

    const uniqueImageList = [...uniqueImages.values()];
    const references = await Promise.all(
      uniqueImageList.map((image) => this.deepSeekFiles.ensureUploaded(image, apiKey, settings.policy, signal))
    );
    const referencesByHash = new Map(uniqueImageList.map((image, index) => [image.hash, references[index]] as const));
    const result = converted.map((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? ({ ...message, content: [...content] } as ChatCompletionMessageParam) : message;
    });
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const content = (result[image.messageIndex] as { content: unknown[] }).content;
      content[image.contentIndex] = { type: "file", file_id: referencesByHash.get(image.image.hash)!.fileId };
    }
    return { messages: result, references };
  }

  private isRejectedDeepSeekFile(error: unknown): boolean {
    const status = (error as { status?: unknown } | null)?.status;
    if (status !== 400) {
      return false;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const file = /\bfile(?:[_ -]?(?:id|api|not[_ -]?found|deleted|expired))?/i.test(detail);
    const missing =
      /(?:expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account)/i.test(detail);
    const invalidId = /(?:invalid.{0,20}file[_ -]?(?:id|api)|file[_ -]?(?:id|api).{0,20}invalid)/i.test(detail);
    return file && (missing || invalidId);
  }

  private async createChatCompletionStream(
    client: NonNullable<ReturnType<CreateOpenAIClient>["client"]>,
    request: Record<string, unknown>,
    options?: Record<string, unknown>,
    sessionId?: string,
    debug?: ChatCompletionDebugOptions
  ): Promise<{
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: ModelUsage | null;
  }> {
    const requestId = crypto.randomUUID();
    const signal = options?.signal as AbortSignal | undefined;
    for (let retryCount = 0; ; retryCount += 1) {
      try {
        return await this.createChatCompletionStreamAttempt(client, request, options, sessionId, debug, requestId);
      } catch (error) {
        if (signal?.aborted || retryCount >= MAX_LLM_RETRIES || !isRetryableLlmError(error)) {
          throw error;
        }
        const attempt = retryCount + 1;
        const delayMs = getLlmRetryAfterMs(error) ?? getLlmRetryDelayMs(attempt);
        const errorMessage = describeLlmError(error);
        if (sessionId) {
          this.onAssistantMessage(
            this.buildAssistantMessage(sessionId, `Request failed: ${errorMessage}`, null),
            false
          );
        }
        this.onLlmRetry?.({
          requestId,
          sessionId,
          error: errorMessage,
          attempt,
          maxRetries: MAX_LLM_RETRIES,
          delayMs,
        });
        await waitForLlmRetry(delayMs, signal);
      }
    }
  }

  private async createChatCompletionStreamAttempt(
    client: NonNullable<ReturnType<CreateOpenAIClient>["client"]>,
    request: Record<string, unknown>,
    options: Record<string, unknown> | undefined,
    sessionId: string | undefined,
    debug: ChatCompletionDebugOptions | undefined,
    requestId: string
  ): Promise<{
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: ModelUsage | null;
  }> {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let estimatedTokens = 0;
    this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "start", sessionId);

    const outerSignal = options?.signal as AbortSignal | undefined;
    const attemptController = new AbortController();
    let timeoutError: Error | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimeoutPromise: Promise<never>;
    const forwardAbort = () => attemptController.abort(outerSignal?.reason);
    const clearAttempt = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      outerSignal?.removeEventListener("abort", forwardAbort);
    };
    const resetIdleTimer = (timeoutMs: number, createError: () => Error) => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimeoutPromise = new Promise((_, reject) => {
        idleTimer = setTimeout(() => {
          const error = createError();
          timeoutError = error;
          attemptController.abort(error);
          reject(error);
        }, timeoutMs);
      });
    };
    if (outerSignal?.aborted) {
      forwardAbort();
    } else {
      outerSignal?.addEventListener("abort", forwardAbort, { once: true });
    }
    resetIdleTimer(LLM_STREAM_FIRST_CHUNK_TIMEOUT_MS, () => new LlmStreamFirstChunkTimeoutError());
    const attemptOptions = { ...options, signal: attemptController.signal, maxRetries: 0 };

    const streamRequest = {
      ...request,
      stream: true,
      stream_options: {
        ...(isUsageRecord(request.stream_options) ? request.stream_options : {}),
        include_usage: true,
      },
    };

    let response: unknown;
    try {
      response = await Promise.race([
        (
          client.chat.completions.create as unknown as (
            body: Record<string, unknown>,
            options?: Record<string, unknown>
          ) => Promise<unknown>
        )(streamRequest, attemptOptions),
        idleTimeoutPromise!,
      ]);
    } catch (error) {
      const requestError = timeoutError ?? error;
      this.logChatCompletionDebug(debug, {
        timestamp: new Date().toISOString(),
        location: debug?.location ?? "SessionManager.createChatCompletionStream:create",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        baseURL: debug?.baseURL,
        durationMs: Date.now() - startedAtMs,
        params: { ...debug?.params, options: summarizeCompletionOptions(attemptOptions) },
        request: streamRequest,
        error: normalizeDebugError(requestError),
      });
      logApiError({
        timestamp: new Date().toISOString(),
        location: "SessionManager.createChatCompletionStream:create",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        error: getLlmErrorDetails(requestError),
        request: streamRequest,
      });
      clearAttempt();
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
      throw requestError;
    }

    if (!response || typeof (response as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      clearAttempt();
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
      this.logChatCompletionDebug(debug, {
        timestamp: new Date().toISOString(),
        location: debug?.location ?? "SessionManager.createChatCompletionStream",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        baseURL: debug?.baseURL,
        durationMs: Date.now() - startedAtMs,
        params: { ...debug?.params, options: summarizeCompletionOptions(attemptOptions) },
        request: streamRequest,
        response,
      });
      return response as { choices?: Array<{ message?: Record<string, unknown> }>; usage?: ModelUsage | null };
    }

    let content = "";
    let reasoningContent = "";
    let refusal: string | null = null;
    let usage: ModelUsage | null = null;
    let streamCompleted = false;
    const responseChunks: unknown[] = [];
    const toolCallsByIndex = new Map<
      number,
      {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }
    >();

    let previewText = "";
    const trackText = (value: unknown, includeInPreview = false) => {
      if (typeof value !== "string" || value.length === 0) {
        return;
      }
      estimatedTokens += this.estimateStreamTokens(value);
      if (includeInPreview) {
        previewText += value;
      }
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "update", sessionId, previewText);
    };

    try {
      const iterator = (response as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
      for (;;) {
        const item = await Promise.race([iterator.next(), idleTimeoutPromise!]);
        if (item.done) {
          break;
        }
        const chunk = item.value;
        resetIdleTimer(LLM_STREAM_IDLE_TIMEOUT_MS, () => new LlmStreamIdleTimeoutError());
        if (debug?.enabled) {
          responseChunks.push(chunk);
        }
        if ("usage" in chunk && chunk.usage != null) {
          usage = chunk.usage as ModelUsage;
          streamCompleted = true;
        }

        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
          if (isUsageRecord(choice) && choice.finish_reason != null) {
            streamCompleted = true;
          }
          const delta = isUsageRecord(choice) && isUsageRecord(choice.delta) ? choice.delta : null;
          if (!delta) {
            continue;
          }

          const contentDelta = delta.content;
          if (typeof contentDelta === "string") {
            content += contentDelta;
            trackText(contentDelta, true);
          }

          const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoningDelta === "string") {
            reasoningContent += reasoningDelta;
            trackText(reasoningDelta, true);
          }

          if (typeof delta.refusal === "string") {
            refusal = `${refusal ?? ""}${delta.refusal}`;
            trackText(delta.refusal);
          }

          const rawToolCalls = delta.tool_calls;
          if (Array.isArray(rawToolCalls)) {
            for (const rawToolCall of rawToolCalls) {
              if (!isUsageRecord(rawToolCall)) {
                continue;
              }
              const index = typeof rawToolCall.index === "number" ? rawToolCall.index : toolCallsByIndex.size;
              const current = toolCallsByIndex.get(index) ?? {};
              if (typeof rawToolCall.id === "string") {
                current.id = rawToolCall.id;
              }
              if (typeof rawToolCall.type === "string") {
                current.type = rawToolCall.type;
              }
              const rawFunction = isUsageRecord(rawToolCall.function) ? rawToolCall.function : null;
              if (rawFunction) {
                current.function = current.function ?? {};
                if (typeof rawFunction.name === "string") {
                  current.function.name = `${current.function.name ?? ""}${rawFunction.name}`;
                  trackText(rawFunction.name);
                }
                if (typeof rawFunction.arguments === "string") {
                  current.function.arguments = `${current.function.arguments ?? ""}${rawFunction.arguments}`;
                  trackText(rawFunction.arguments);
                }
              }
              toolCallsByIndex.set(index, current);
            }
          }
        }
      }
      if (!streamCompleted) {
        throw new LlmStreamDisconnectedError();
      }
    } catch (error) {
      const streamError = timeoutError ?? error;
      this.logChatCompletionDebug(debug, {
        timestamp: new Date().toISOString(),
        location: debug?.location ?? "SessionManager.createChatCompletionStream:stream",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        baseURL: debug?.baseURL,
        durationMs: Date.now() - startedAtMs,
        params: { ...debug?.params, options: summarizeCompletionOptions(attemptOptions) },
        request: streamRequest,
        responseChunks,
        error: normalizeDebugError(streamError),
      });
      logApiError({
        timestamp: new Date().toISOString(),
        location: "SessionManager.createChatCompletionStream:stream",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        error: getLlmErrorDetails(streamError),
        request: streamRequest,
      });
      throw streamError;
    } finally {
      clearAttempt();
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
    }

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall);
    const normalizedToolCalls = this.normalizeLlmToolCalls(toolCalls);
    const message: Record<string, unknown> = { content };
    if (normalizedToolCalls) {
      message.tool_calls = normalizedToolCalls;
    }
    if (reasoningContent.length > 0) {
      message.reasoning_content = reasoningContent;
    }
    if (refusal != null) {
      message.refusal = refusal;
    }

    const finalResponse = {
      choices: [{ message }],
      usage,
    };
    this.logChatCompletionDebug(debug, {
      timestamp: new Date().toISOString(),
      location: debug?.location ?? "SessionManager.createChatCompletionStream",
      requestId,
      sessionId,
      model: typeof request.model === "string" ? request.model : undefined,
      baseURL: debug?.baseURL,
      durationMs: Date.now() - startedAtMs,
      params: { ...debug?.params, options: summarizeCompletionOptions(attemptOptions) },
      request: streamRequest,
      responseChunks,
      response: finalResponse,
    });
    return finalResponse;
  }

  private logChatCompletionDebug(
    debug: ChatCompletionDebugOptions | undefined,
    entry: Parameters<typeof logOpenAIChatCompletionDebug>[0]
  ): void {
    if (!debug?.enabled) {
      return;
    }
    logOpenAIChatCompletionDebug(entry);
  }

  async identifyMatchingSkillNames(
    skills: SkillInfo[],
    userPrompt: string,
    options?: { signal?: AbortSignal; sessionId?: string }
  ): Promise<string[]> {
    this.throwIfAborted(options?.signal);
    let systemPrompt = `When users ask you to perform tasks, check if any of the available skills match the goal and situation. Skills provide specialized capabilities and domain knowledge.\n
Response in JSON format:
\`\`\`
{
  "skillNames": ["", ...]
}
\`\`\`\n
If none of the available skills match, respond with an empty array, i.e. \`{"skillNames": []}\`.\n
`;
    const simpleSkills = skills
      .filter((x) => !x.isLoaded && x.allowImplicitInvocation !== false)
      .map((x) => {
        return { name: x.name, description: x.description };
      });
    if (simpleSkills.length === 0) {
      return [];
    }
    const candidateSkillNames = new Set(simpleSkills.map((skill) => skill.name));

    const { client, model, baseURL, debugLogEnabled } = this.createOpenAIClient();
    if (!client) {
      return [];
    }

    const agentInstructions = this.loadAgentInstructions();
    if (agentInstructions) {
      systemPrompt += `Use the current agent instructions as additional context when deciding which skills match:\n
<agent-instructions>
${agentInstructions}
</agent-instructions>\n
`;
    }
    systemPrompt += "The candidate skills are as follows:\n\n";
    systemPrompt += "```\n" + JSON.stringify(simpleSkills, null, 2) + "\n```";

    try {
      const response = await this.createChatCompletionStream(
        client,
        {
          model,
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
        },
        options?.signal ? { signal: options.signal } : undefined,
        options?.sessionId,
        {
          enabled: debugLogEnabled,
          location: "SessionManager.identifyMatchingSkillNames",
          baseURL,
          params: { purpose: "skill-matching", temperature: 0.1 },
        }
      );
      this.throwIfAborted(options?.signal);

      const rawContent = response.choices?.[0]?.message?.content;
      const content = typeof rawContent === "string" ? rawContent : "";
      if (!content) {
        return [];
      }

      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.skillNames)) {
        return parsed.skillNames.filter(
          (skillName: unknown): skillName is string =>
            typeof skillName === "string" && candidateSkillNames.has(skillName)
        );
      }

      return [];
    } catch (error) {
      if (this.isAbortLikeError(error) || options?.signal?.aborted) {
        throw error;
      }
      return [];
    }
  }

  private getSkillScanRoots(): Array<{ root: string; displayRoot: string }> {
    const homeDir = os.homedir();
    return [
      { root: path.join(this.projectRoot, ".deepcode", "skills"), displayRoot: "./.deepcode/skills" },
      { root: path.join(this.projectRoot, ".agents", "skills"), displayRoot: "./.agents/skills" },
      { root: path.join(homeDir, ".deepcode", "skills"), displayRoot: "~/.deepcode/skills" },
      { root: path.join(homeDir, ".agents", "skills"), displayRoot: "~/.agents/skills" },
      { root: this.getBundledSkillsRoot(), displayRoot: "bundled:" },
    ];
  }

  private getBundledSkillsRoot(): string {
    const extensionRoot = getExtensionRoot();
    const sourceRoot = path.join(extensionRoot, "templates", "skills", "bundled");

    // Source check keeps local development/tests on the checked-in templates.
    if (fs.existsSync(path.join(extensionRoot, "src", "session.ts")) && fs.existsSync(sourceRoot)) {
      return sourceRoot;
    }

    // In the published bundle, getExtensionRoot() resolves to dist/ and
    // bundled skills are copied to dist/bundled/ (not dist/templates/skills/bundled/).
    const distRoot = path.join(extensionRoot, "bundled");
    return fs.existsSync(distRoot) ? distRoot : sourceRoot;
  }

  async listSkills(sessionId?: string): Promise<SkillInfo[]> {
    const skillRoots = this.getSkillScanRoots();
    const enabledSkills = this.getResolvedSettings().enabledSkills ?? {};
    const skillsByName = new Map<string, SkillInfo>();

    const collectSkills = (root: string, displayRoot: string): SkillInfo[] => {
      if (!fs.existsSync(root)) {
        return [];
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }

      const results: SkillInfo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }
        const skillName = entry.name;
        const skillPath = path.join(root, skillName, "SKILL.md");
        try {
          if (!fs.existsSync(skillPath)) {
            continue;
          }
          const stat = fs.statSync(skillPath);
          if (!stat.isFile()) {
            continue;
          }
        } catch {
          continue;
        }
        const displayPath =
          displayRoot === "bundled:" ? `bundled:${skillName}/SKILL.md` : `${displayRoot}/${skillName}/SKILL.md`;
        const skill = this.readSkillInfo(skillPath, displayPath, skillName);
        if (enabledSkills[skill.name] === false) {
          continue;
        }
        results.push(skill);
      }
      return results;
    };

    for (const { root, displayRoot } of skillRoots) {
      for (const skill of collectSkills(root, displayRoot)) {
        if (!skillsByName.has(skill.name)) {
          skillsByName.set(skill.name, skill);
        }
      }
    }

    if (sessionId) {
      const loadedSkillKeys = this.getLoadedSkillKeys(sessionId);
      for (const skill of skillsByName.values()) {
        if (loadedSkillKeys.has(this.getSkillKey(skill)) || loadedSkillKeys.has(this.getSkillKeyByName(skill.name))) {
          skill.isLoaded = true;
        }
      }
    }

    return Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private resolveSkillPath(skillPath: string): string {
    if (skillPath.startsWith("bundled:")) {
      const relativePath = skillPath.slice("bundled:".length);
      const root = this.getBundledSkillsRoot();
      const resolvedPath = path.resolve(root, relativePath);
      const resolvedRoot = path.resolve(root);
      if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        return path.join(root, "__invalid_bundled_skill__");
      }
      return resolvedPath;
    }
    if (skillPath.startsWith("~/")) {
      return path.join(os.homedir(), skillPath.slice(2));
    }
    if (skillPath.startsWith("~\\")) {
      return path.join(os.homedir(), skillPath.slice(2));
    }
    if (skillPath.startsWith("./")) {
      return path.join(this.projectRoot, skillPath.slice(2));
    }
    if (skillPath.startsWith(".\\")) {
      return path.join(this.projectRoot, skillPath.slice(2));
    }
    if (path.isAbsolute(skillPath)) {
      return skillPath;
    }
    return path.join(os.homedir(), skillPath);
  }

  private buildSkillPrompt(skill: SkillInfo): string {
    const skillPath = this.resolveSkillPath(skill.path);
    return buildSkillDocumentsPrompt([
      {
        name: skill.name,
        content: fs.readFileSync(skillPath, "utf8"),
        path: skillPath,
        skillFilePath: skillPath,
      },
    ]);
  }

  private readSkillInfo(skillPath: string, displayPath: string, fallbackName: string): SkillInfo {
    const fallbackSkill: SkillInfo = {
      name: fallbackName.replace(/_/g, "-"),
      path: displayPath,
      description: "",
    };

    try {
      const skillMd = fs.readFileSync(skillPath, "utf8");
      const parsed = matter(skillMd);
      const metadata = parsed.data.metadata;
      const allowImplicitInvocation =
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        (metadata as Record<string, unknown>)["allow-implicit-invocation"] === false
          ? false
          : undefined;
      return {
        name:
          typeof parsed.data.name === "string" && parsed.data.name.trim()
            ? parsed.data.name.trim()
            : fallbackSkill.name,
        path: displayPath,
        description: typeof parsed.data.description === "string" ? parsed.data.description.trim() : "",
        allowImplicitInvocation,
      };
    } catch {
      return fallbackSkill;
    }
  }

  private getSkillKey(skill: Pick<SkillInfo, "path">): string {
    return `path:${skill.path}`;
  }

  private getSkillKeyByName(name: string): string {
    return `name:${name}`;
  }

  private getLoadedSkillKeys(sessionId: string): Set<string> {
    const loadedSkillKeys = new Set<string>();
    for (const message of this.listSessionMessages(sessionId)) {
      if ((message.role !== "system" && message.role !== "tool") || !message.meta?.skill) {
        continue;
      }
      loadedSkillKeys.add(this.getSkillKey(message.meta.skill));
      loadedSkillKeys.add(this.getSkillKeyByName(message.meta.skill.name));
    }
    return loadedSkillKeys;
  }

  private dedupeSkills(skills?: SkillInfo[]): SkillInfo[] | undefined {
    if (!skills || skills.length === 0) {
      return undefined;
    }

    const dedupedSkills = new Map<string, SkillInfo>();
    for (const skill of skills) {
      if (!skill?.name || !skill?.path) {
        continue;
      }
      const key = this.getSkillKey(skill);
      const existingSkill = dedupedSkills.get(key);
      dedupedSkills.set(key, {
        ...existingSkill,
        ...skill,
        description: skill.description ?? existingSkill?.description ?? "",
        isLoaded: Boolean(existingSkill?.isLoaded || skill.isLoaded),
      });
    }

    return Array.from(dedupedSkills.values());
  }

  private async normalizeSkills(skills?: SkillInfo[], sessionId?: string): Promise<SkillInfo[] | undefined> {
    const dedupedSkills = this.dedupeSkills(skills);
    if (!dedupedSkills || dedupedSkills.length === 0) {
      return undefined;
    }

    const availableSkills = await this.listSkills(sessionId);
    const availableSkillsByKey = new Map<string, SkillInfo>();
    for (const skill of availableSkills) {
      availableSkillsByKey.set(this.getSkillKey(skill), skill);
      availableSkillsByKey.set(this.getSkillKeyByName(skill.name), skill);
    }

    return dedupedSkills.map((skill) => {
      const matchedSkill =
        availableSkillsByKey.get(this.getSkillKey(skill)) ??
        availableSkillsByKey.get(this.getSkillKeyByName(skill.name));
      if (!matchedSkill) {
        return skill;
      }
      return {
        ...matchedSkill,
        ...skill,
        description: matchedSkill.description || skill.description,
        isLoaded: Boolean(matchedSkill.isLoaded || skill.isLoaded),
      };
    });
  }

  private appendSkillMessages(sessionId: string, skills?: SkillInfo[]): void {
    if (!skills || skills.length === 0) {
      return;
    }

    for (const skill of skills) {
      if (skill.isLoaded) {
        continue;
      }
      const skillPrompt = this.buildSkillPrompt(skill);
      const skillMessage = this.buildSkillMessage(sessionId, skillPrompt, skill);
      this.appendSessionMessage(sessionId, skillMessage);
      this.onAssistantMessage(skillMessage, true);
    }
  }

  private listPreloadedSkillCatalog(sessionId: string): Array<{ name: string; description: string }> {
    const entries = new Map<string, { name: string; description: string }>();
    for (const message of this.listSessionMessages(sessionId)) {
      if (message.role !== "system") {
        continue;
      }
      const catalog = message.meta?.skillCatalog;
      if (!Array.isArray(catalog)) {
        continue;
      }
      for (const entry of catalog) {
        if (!entry || typeof entry.name !== "string" || !entry.name || entries.has(entry.name)) {
          continue;
        }
        entries.set(entry.name, {
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
        });
      }
    }
    return Array.from(entries.values());
  }

  private mergeSkillCatalog(
    previous: Array<{ name: string; description: string }>,
    next: Array<{ name: string; description: string }>
  ): Array<{ name: string; description: string }> {
    const merged = [...previous];
    const seen = new Set(previous.map((entry) => entry.name));
    for (const entry of next) {
      if (seen.has(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      merged.push(entry);
    }
    return merged;
  }

  private appendSkillCatalogMessage(sessionId: string, skills: Array<{ name: string; description: string }>): void {
    if (skills.length === 0) {
      return;
    }
    const content = buildSkillCatalogPrompt(skills);
    const lastCatalogMessage = [...this.listSessionMessages(sessionId)]
      .reverse()
      .find((message) => message.role === "system" && Array.isArray(message.meta?.skillCatalog));
    if (lastCatalogMessage?.content === content) {
      return;
    }
    const message = this.buildSystemMessage(sessionId, content, null, false, { skillCatalog: skills });
    this.appendSessionMessage(sessionId, message);
  }

  async loadSkillByName(sessionId: string, skillName: string): Promise<ToolExecutionResult> {
    const skills = await this.listSkills(sessionId);
    const skill = skills.find((candidate) => candidate.name === skillName);
    if (!skill) {
      return {
        ok: false,
        name: "skill",
        error: `Unknown skill: ${skillName}. Check the available skills catalog for exact skill names.`,
      };
    }
    if (skill.isLoaded) {
      return {
        ok: true,
        name: "skill",
        output: `Skill already loaded: ${skill.name}.`,
      };
    }
    return {
      ok: true,
      name: "skill",
      output: this.buildSkillPrompt(skill),
      metadata: { skill: { ...skill, isLoaded: true } },
    };
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  setActiveSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  addSessionSystemMessage(sessionId: string, content: string, visible?: boolean, meta?: MessageMeta): void {
    const message = this.buildSystemMessage(sessionId, content, null, visible, meta);
    if (sessionId) this.appendSessionMessage(sessionId, message);
    this.onAssistantMessage(message, false);
  }

  async handleUserPrompt(userPrompt: UserPromptContent): Promise<void> {
    const controller = new AbortController();
    this.activePromptController = controller;

    try {
      if (!this.activeSessionId || !this.getSession(this.activeSessionId)) {
        await this.createSession(userPrompt, controller);
      } else {
        await this.replySession(this.activeSessionId, userPrompt, controller);
      }
    } catch (error) {
      if (!this.isAbortLikeError(error) && !controller.signal.aborted) {
        throw error;
      }
    } finally {
      if (this.activePromptController === controller) {
        this.activePromptController = null;
      }
    }
  }

  async createSession(userPrompt: UserPromptContent, controller?: AbortController): Promise<string> {
    this.reportNewPrompt();
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const sessionId = crypto.randomUUID();
    const originalSummary = userPrompt.text ? userPrompt.text.slice(0, 100) : "[Image Prompt]";
    userPrompt = this.preparePromptImages(sessionId, userPrompt);
    this.ensureFileHistorySession(sessionId);
    const now = new Date().toISOString();
    const index = this.loadSessionsIndex();
    const entry: SessionEntry = {
      id: sessionId,
      summary: originalSummary,
      assistantReply: null,
      assistantThinking: null,
      assistantRefusal: null,
      toolCalls: null,
      status: "pending",
      failReason: null,
      usage: null,
      usagePerModel: null,
      activeTokens: 0,
      intentNarrationRejections: 0,
      createTime: now,
      updateTime: now,
      processes: null,
      planMode: Boolean(userPrompt.planMode),
    };
    index.entries.push(entry);
    const sortedEntries = index.entries.slice().sort((a, b) => {
      const aTime = Date.parse(a.updateTime);
      const bTime = Date.parse(b.updateTime);
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
        return b.updateTime.localeCompare(a.updateTime);
      }
      return bTime - aTime;
    });
    const keptEntries = sortedEntries.slice(0, MAX_SESSION_ENTRIES);
    const keptIds = new Set(keptEntries.map((item) => item.id));
    const droppedEntries = sortedEntries.filter((item) => !keptIds.has(item.id));
    index.entries = keptEntries;
    this.saveSessionsIndex(index);
    for (const dropped of droppedEntries) {
      this.cleanupSessionResources(dropped.id, {
        removeMessages: true,
        processIds: this.getProcessIds(dropped.processes ?? null),
      });
    }

    const promptToolOptions = this.getPromptToolOptions();
    const systemPrompt = getSystemPrompt(this.projectRoot, promptToolOptions);
    const systemMessage = this.buildSystemMessage(sessionId, systemPrompt);
    this.appendSessionMessage(sessionId, systemMessage);

    const runtimeContextMessage = this.buildSystemMessage(
      sessionId,
      getRuntimeContext(
        this.projectRoot,
        promptToolOptions.model,
        this.getResolvedSettings().permissions?.addWorkingDirs
      )
    );
    this.appendSessionMessage(sessionId, runtimeContextMessage);

    const agentInstructions = this.loadAgentInstructions();
    if (agentInstructions) {
      const instructionsMessage = this.buildSystemMessage(sessionId, agentInstructions);
      this.appendSessionMessage(sessionId, instructionsMessage);
    }

    this.appendPlanModeTransitionMessages(sessionId, false, Boolean(userPrompt.planMode));

    this.recordUserPromptCheckpoint(sessionId);
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    let matchedSkills: SkillInfo[] = [];
    if (userPrompt.text) {
      const skills = await this.listSkills();
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      matchedSkills = skills.filter((skill) => skillSet.has(skill.name));
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills);
    this.throwIfAborted(signal);

    this.appendSkillMessages(sessionId, userPrompt.skills);
    this.appendSkillCatalogMessage(
      sessionId,
      this.mergeSkillCatalog(
        this.listPreloadedSkillCatalog(sessionId),
        matchedSkills.map((skill) => ({ name: skill.name, description: skill.description }))
      )
    );

    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
    return sessionId;
  }

  async replySession(sessionId: string, userPrompt: UserPromptContent, controller?: AbortController): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);
    if (!this.getSession(sessionId)) {
      await this.createSession(userPrompt, controller);
      return;
    }
    userPrompt = this.preparePromptImages(sessionId, userPrompt);
    appendProjectPermissionAllows(this.projectRoot, userPrompt.alwaysAllows, {
      inheritedPermissions: this.getResolvedSettings().permissions,
    });
    const now = new Date().toISOString();
    const previousPlanMode = Boolean(this.getSession(sessionId)?.planMode);
    const nextPlanMode = Boolean(userPrompt.planMode);
    const updated = this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "pending",
      failReason: null,
      askPermissions: undefined,
      planMode: nextPlanMode,
      updateTime: now,
    }));

    if (!updated) return;

    this.appendPlanModeTransitionMessages(sessionId, previousPlanMode, nextPlanMode);

    if (hasUserPermissionReplies(userPrompt) && this.hasTrailingPendingToolCalls(sessionId)) {
      this.activeSessionId = sessionId;
      await this.activateSession(sessionId, controller, userPrompt);
      return;
    }

    if (this.isContinuePrompt(userPrompt)) {
      this.activeSessionId = sessionId;
      await this.activateSession(sessionId, controller, userPrompt);
      return;
    }

    this.reportNewPrompt();

    this.ensureFileHistorySession(sessionId);
    const checkpoint = this.recordUserPromptCheckpoint(sessionId);
    if (checkpoint.changedFilePaths.length) {
      const content = `Note that the user manually modified these files:\n${checkpoint.changedFilePaths.join("\n")}`;
      this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, content));
    }
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    let matchedSkills: SkillInfo[] = [];
    if (userPrompt.text) {
      const skills = await this.listSkills(sessionId);
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal, sessionId });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      matchedSkills = skills.filter((skill) => skillSet.has(skill.name));
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills, sessionId);
    this.throwIfAborted(signal);

    this.appendSkillMessages(sessionId, userPrompt.skills);
    this.appendSkillCatalogMessage(
      sessionId,
      this.mergeSkillCatalog(
        this.listPreloadedSkillCatalog(sessionId),
        matchedSkills.map((skill) => ({ name: skill.name, description: skill.description }))
      )
    );
    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
  }

  private isContinuePrompt(userPrompt: UserPromptContent): boolean {
    return (
      typeof userPrompt.text === "string" &&
      userPrompt.text.trim() === "/continue" &&
      (!userPrompt.imageUrls || userPrompt.imageUrls.length === 0) &&
      (!userPrompt.skills || userPrompt.skills.length === 0)
    );
  }

  async activateSession(
    sessionId: string,
    controller?: AbortController,
    permissionPrompt?: UserPromptContent
  ): Promise<void> {
    const startedAt = Date.now();
    const {
      client,
      apiKey,
      model,
      baseURL,
      temperature,
      thinkingEnabled,
      reasoningEffort,
      debugLogEnabled,
      notify,
      env,
    } = this.createOpenAIClient();
    const now = new Date().toISOString();
    rebuildSessionStateFromHistory(sessionId, this.listSessionMessages(sessionId));

    if (!client) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: "API key not found",
        updateTime: now,
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          "API key not found. Please configure ~/.deepcode/settings.json or ./.deepcode/settings.json.",
          null
        ),
        false
      );
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
      return;
    }

    const sessionController = controller ?? new AbortController();
    if (sessionController.signal.aborted) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "interrupted",
        failReason: "interrupted",
        updateTime: now,
      }));
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
      return;
    }

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      updateTime: now,
    }));

    this.sessionControllers.set(sessionId, sessionController);

    try {
      const maxIterations = 80000; // about 1K RMB cost
      let toolCalls: unknown[] | null = null;
      let intentNarrationHistory: boolean[] = [];

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (this.isInterrupted(sessionId)) {
          return;
        }

        const session = this.getSession(sessionId);
        if (session == null || session.status === "interrupted" || session.status === "failed") {
          return;
        }

        const pendingToolCallMessage = this.messageConverter.getTrailingPendingToolCallMessage(
          this.listSessionMessages(sessionId)
        );
        if (pendingToolCallMessage.toolCalls.length > 0) {
          const pendingToolCalls = pendingToolCallMessage.toolCalls.slice(0, 1);
          const toolAppendResult = await this.appendToolMessages(sessionId, pendingToolCalls, {
            permissionOverrides: permissionPrompt?.permissions,
            messagePermissions: pendingToolCallMessage.message?.meta?.permissions,
          });
          await this.appendDeferredPermissionPrompt(sessionId, permissionPrompt, sessionController);
          // Permission replies are one-shot: do not reuse decisions or append the deferred user prompt again on later tool-call batches.
          permissionPrompt = undefined;
          if (this.isInterrupted(sessionId)) {
            return;
          }
          if (toolAppendResult.waitingForUser) {
            this.updateSessionEntry(sessionId, (entry) => ({
              ...entry,
              toolCalls: pendingToolCalls,
              status: "waiting_for_user",
              updateTime: new Date().toISOString(),
            }));
            return;
          }
        }

        const compactPromptTokenThreshold =
          this.getResolvedSettings().autoCompactWindow ?? getCompactPromptTokenThreshold(model);
        if (session.activeTokens > compactPromptTokenThreshold) {
          const message = this.buildAssistantMessage(
            sessionId,
            "The conversation is getting long, compacting...",
            null
          );
          message.meta = { asThinking: true };
          this.onAssistantMessage(message, false);
          await this.compactSession(sessionId, sessionController.signal);
        }

        const sessionMessages = await this.attachPromptImagesForRequest(
          this.prepareSessionMessagesForRequest(this.listSessionMessages(sessionId)),
          model,
          this.getResolvedSettings().multimodal
        );
        if (this.isInterrupted(sessionId)) {
          return;
        }
        const filesSettings = this.getDeepSeekFilesSettings();
        if (filesSettings.enabled && !apiKey) {
          throw new Error("Files API is enabled, but no API key is available for uploads.");
        }
        let prepared = filesSettings.enabled
          ? await this.buildMessagesWithDeepSeekFiles(
              sessionMessages,
              thinkingEnabled,
              model,
              apiKey!,
              sessionController.signal
            )
          : {
              messages: this.messageConverter.buildMessages(
                sessionMessages,
                thinkingEnabled,
                model,
                this.getResolvedSettings().multimodal
              ),
              references: [] as DeepSeekFileReference[],
            };
        const thinkingOptions = buildThinkingRequestOptions(thinkingEnabled, baseURL, reasoningEffort);
        const request = () =>
          this.createChatCompletionStream(
            client,
            {
              model,
              ...(temperature !== undefined ? { temperature } : {}),
              messages: prepared.messages,
              tools: getTools(this.getPromptToolOptions(), this.mcpToolDefinitions),
              ...thinkingOptions,
            },
            { signal: sessionController.signal },
            sessionId,
            {
              enabled: debugLogEnabled,
              location: "SessionManager.activateSession",
              baseURL,
              params: { iteration, temperature, thinkingEnabled, reasoningEffort },
            }
          );
        let response: Awaited<ReturnType<typeof request>>;
        try {
          response = await request();
        } catch (error) {
          if (!filesSettings.enabled || prepared.references.length === 0 || !this.isRejectedDeepSeekFile(error)) {
            throw error;
          }
          for (const reference of prepared.references) {
            this.deepSeekFiles.invalidate(reference, apiKey!);
          }
          prepared = await this.buildMessagesWithDeepSeekFiles(
            sessionMessages,
            thinkingEnabled,
            model,
            apiKey!,
            sessionController.signal
          );
          response = await request();
        }

        const message = response.choices?.[0]?.message;
        const rawContent = message?.content;
        const content = typeof rawContent === "string" ? rawContent : "";
        const rawToolCalls = (message as { tool_calls?: unknown[] } | undefined)?.tool_calls ?? null;
        toolCalls = this.normalizeLlmToolCalls(rawToolCalls);
        const rawThinking = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        const thinking = typeof rawThinking === "string" ? rawThinking : null;
        const refusal = (message as { refusal?: string } | undefined)?.refusal ?? null;
        // const html = content ? this.renderMarkdown(content) : "";

        if (this.isInterrupted(sessionId)) {
          return;
        }
        const intentNarrationGuard =
          this.getResolvedSettings().intentNarrationGuard ?? DEFAULT_INTENT_NARRATION_GUARD_SETTINGS;
        const matchedIntentPhrase = findIntentNarrationPhrase(content, Boolean(toolCalls), intentNarrationGuard);
        intentNarrationHistory = recordRejectionInWindow(
          intentNarrationHistory,
          Boolean(matchedIntentPhrase),
          intentNarrationGuard.hardStopWindow
        );
        if (matchedIntentPhrase) {
          const responseUsage = response.usage ?? null;
          const hardStopped = shouldHardStopIntentNarration(intentNarrationHistory, intentNarrationGuard);
          const failReason = hardStopped
            ? `Intent narration guard stopped the run after ${intentNarrationHistory.filter(Boolean).length} rejected turns within the last ${intentNarrationGuard.hardStopWindow} model turns.`
            : null;
          const updatedEntry = this.updateSessionEntry(sessionId, (entry) => ({
            ...entry,
            assistantReply: hardStopped ? failReason : intentNarrationGuard.instruction,
            assistantThinking: thinking,
            assistantRefusal: refusal,
            toolCalls: null,
            usage: accumulateUsage(entry.usage, responseUsage),
            usagePerModel: accumulateUsagePerModel(entry.usagePerModel, model, responseUsage),
            activeTokens: getTotalTokens(responseUsage),
            status: hardStopped ? "failed" : "processing",
            failReason,
            askPermissions: undefined,
            intentNarrationRejections: (entry.intentNarrationRejections ?? 0) + 1,
            updateTime: new Date().toISOString(),
          }));
          const event = createIntentNarrationRejectionEvent({
            content,
            sessionId,
            stepId: `${sessionId}:${iteration + 1}`,
            matchedPhrase: matchedIntentPhrase,
            totalRejections: updatedEntry?.intentNarrationRejections ?? 1,
            rejectionHistory: intentNarrationHistory,
            windowSize: intentNarrationGuard.hardStopWindow,
            hardStopped,
          });
          logIntentNarrationRejection(event);
          this.onIntentNarrationRejected?.(event);

          const correctionMessage = this.buildSystemMessage(sessionId, intentNarrationGuard.instruction, null, true, {
            asThinking: true,
          });
          this.appendSessionMessage(sessionId, correctionMessage);
          this.onAssistantMessage(correctionMessage, true);

          if (hardStopped) {
            const failureMessage = this.buildAssistantMessage(sessionId, failReason, null);
            this.appendSessionMessage(sessionId, failureMessage);
            this.onAssistantMessage(failureMessage, false);
            return;
          }
          continue;
        }
        const assistantMessage = this.buildAssistantMessage(sessionId, content, toolCalls, thinking);
        const permissionPlan = toolCalls
          ? computeToolCallPermissions({
              sessionId,
              projectRoot: this.projectRoot,
              toolCalls,
              settings: this.getResolvedSettings().permissions,
              forceAskScopes: this.getSession(sessionId)?.planMode ? PLAN_MODE_FORCE_ASK_SCOPES : undefined,
              readPermissionExemptPaths: this.getReadPermissionExemptPaths(sessionId),
              resolveSnippetPath: (id, snippetId) => getSnippet(id, snippetId)?.filePath,
            })
          : null;
        if (permissionPlan) {
          assistantMessage.meta = {
            ...(assistantMessage.meta ?? {}),
            permissions: permissionPlan.permissions,
          };
        }
        this.appendSessionMessage(sessionId, assistantMessage);
        this.onAssistantMessage(assistantMessage, true);

        let waitingForUser = false;
        const responseUsage = response.usage ?? null;
        if (toolCalls) {
          if (permissionPlan?.askPermissions.length) {
            this.updateSessionEntry(sessionId, (entry) => ({
              ...entry,
              assistantReply: content,
              assistantThinking: thinking,
              assistantRefusal: refusal,
              toolCalls,
              usage: accumulateUsage(entry.usage, responseUsage),
              usagePerModel: accumulateUsagePerModel(entry.usagePerModel, model, responseUsage),
              activeTokens: getTotalTokens(responseUsage),
              status: "ask_permission",
              failReason: null,
              askPermissions: permissionPlan.askPermissions,
              updateTime: new Date().toISOString(),
            }));
            return;
          }
          const toolAppendResult = await this.appendToolMessages(sessionId, toolCalls, {
            messagePermissions: permissionPlan?.permissions,
          });
          waitingForUser = toolAppendResult.waitingForUser;
        }

        if (this.isInterrupted(sessionId)) {
          return;
        }

        this.updateSessionEntry(sessionId, (entry) => ({
          ...entry,
          assistantReply: content,
          assistantThinking: thinking,
          assistantRefusal: refusal,
          toolCalls,
          usage: accumulateUsage(entry.usage, responseUsage),
          usagePerModel: accumulateUsagePerModel(entry.usagePerModel, model, responseUsage),
          activeTokens: getTotalTokens(responseUsage),
          status: refusal ? "failed" : waitingForUser ? "waiting_for_user" : toolCalls ? "processing" : "completed",
          failReason: refusal ? refusal : entry.failReason,
          askPermissions: undefined,
          updateTime: new Date().toISOString(),
        }));

        if (refusal) {
          return;
        }

        if (waitingForUser) {
          return;
        }

        if (!toolCalls) {
          return;
        }
      }

      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "completed",
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          "The AI agent has taken several steps but hasn't reached a conclusion yet. Do you want to continue?",
          null
        ),
        false
      );
    } catch (error) {
      const errMessage = describeLlmError(error);
      const aborted = this.isAbortLikeError(error) || sessionController.signal.aborted;
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: aborted ? "interrupted" : "failed",
        failReason: aborted ? "interrupted" : errMessage,
        updateTime: new Date().toISOString(),
      }));

      if (!aborted) {
        this.onAssistantMessage(this.buildAssistantMessage(sessionId, `Request failed: ${errMessage}`, null), false);
      }
    } finally {
      if (this.sessionControllers.get(sessionId) === sessionController) {
        this.sessionControllers.delete(sessionId);
      }
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
    }
  }

  async compactSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const { client, model, baseURL, temperature, thinkingEnabled, reasoningEffort, debugLogEnabled } =
      this.createOpenAIClient();
    if (!client) {
      return;
    }
    const sessionMessages = this.listSessionMessages(sessionId).filter((message) => !message.compacted);
    if (sessionMessages.length === 0) {
      return;
    }

    const startIndex = sessionMessages.findIndex((message) => message.role !== "system");
    if (startIndex === -1) {
      return;
    }

    const searchStart = Math.floor(startIndex + ((sessionMessages.length - startIndex) * 2) / 3);
    let endIndex = -1;
    for (let i = Math.max(searchStart, startIndex); i < sessionMessages.length; i += 1) {
      if (sessionMessages[i].role !== "tool") {
        endIndex = i;
        break;
      }
    }
    if (endIndex === -1 || endIndex <= startIndex) {
      return;
    }

    const compactPrompt = getCompactPrompt(sessionMessages.slice(startIndex, endIndex));
    const thinkingOptions = buildThinkingRequestOptions(thinkingEnabled, baseURL, reasoningEffort);
    const response = await this.createChatCompletionStream(
      client,
      {
        model,
        ...(temperature !== undefined ? { temperature } : {}),
        messages: [{ role: "user", content: compactPrompt }],
        ...thinkingOptions,
      },
      signal ? { signal } : undefined,
      sessionId,
      {
        enabled: debugLogEnabled,
        location: "SessionManager.compactSession",
        baseURL,
        params: { temperature, thinkingEnabled, reasoningEffort },
      }
    );
    this.throwIfAborted(signal);
    const rawLlmResponse = response.choices?.[0]?.message?.content;
    const llmResponse = typeof rawLlmResponse === "string" ? rawLlmResponse : "";
    const compactedSummary = llmResponse.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();

    const now = new Date().toISOString();
    const responseUsage = response.usage ?? null;
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      usage: accumulateUsage(entry.usage, responseUsage),
      usagePerModel: accumulateUsagePerModel(entry.usagePerModel, model, responseUsage),
      activeTokens: getTotalTokens(responseUsage),
      updateTime: now,
    }));

    for (let i = startIndex; i < endIndex; i += 1) {
      if (sessionMessages[i].meta?.skillCatalog) {
        continue;
      }
      sessionMessages[i] = { ...sessionMessages[i], compacted: true, updateTime: now };
    }

    const summaryMessage: SessionMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "system",
      content: `There are earlier parts of the conversation. Here is a summary: \n\n${compactedSummary}`,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: now,
      updateTime: now,
      meta: {
        isSummary: true,
      },
    };
    sessionMessages.splice(endIndex, 0, summaryMessage);
    this.saveSessionMessages(sessionId, sessionMessages);
  }

  private getPromptToolOptions(): {
    model: string;
    multimodal?: MultimodalMode;
    webSearchEnabled: boolean;
    nonInteractive: boolean;
  } {
    return {
      model: this.getResolvedSettings().model,
      multimodal: this.getResolvedSettings().multimodal,
      webSearchEnabled: true,
      nonInteractive: this.nonInteractive,
    };
  }

  private prepareSessionMessagesForRequest(messages: SessionMessage[]): SessionMessage[] {
    if (!this.nonInteractive) {
      return messages;
    }

    const systemPromptIndex = messages.findIndex(
      (message) => message.role === "system" && message.content?.includes("# Available Tools")
    );
    if (systemPromptIndex === -1) {
      return messages;
    }

    const prepared = messages.slice();
    prepared[systemPromptIndex] = {
      ...prepared[systemPromptIndex],
      content: getSystemPrompt(this.projectRoot, this.getPromptToolOptions()),
    };
    return prepared;
  }

  private async attachPromptImagesForRequest(
    messages: SessionMessage[],
    model: string,
    multimodal: MultimodalMode = "default"
  ): Promise<SessionMessage[]> {
    const includeImageContent = supportsMultimodal(model, multimodal);
    const prepared = await Promise.all(
      messages.map(async (message) => {
        const imageUrls = message.role === "user" ? message.meta?.userPrompt?.imageUrls : undefined;
        const promptImages: Array<{ source: "file" | "url"; value: string }> = [];
        for (const imageUrl of imageUrls ?? []) {
          const filePath = this.getLocalPromptImagePath(imageUrl);
          if (filePath) {
            promptImages.push({ source: "file", value: filePath });
          } else if (/^https?:\/\//i.test(imageUrl)) {
            promptImages.push({ source: "url", value: imageUrl });
          }
        }
        if (promptImages.length === 0) {
          return message;
        }

        const contentParams = Array.isArray(message.contentParams)
          ? [...message.contentParams]
          : message.contentParams
            ? [message.contentParams]
            : [];
        if (includeImageContent) {
          const imageParts = await Promise.all(
            promptImages.map(async ({ source, value }) => {
              if (source === "url") {
                return { type: "image_url", image_url: { url: value } };
              }
              const { image } = await loadImageFile(value, this.loadSharp);
              return {
                type: "image_url",
                image_url: { url: `data:${image.mediaType};base64,${image.data.toString("base64")}` },
              };
            })
          );
          for (const imagePart of imageParts) {
            contentParams.push(imagePart);
          }
        }
        if (!includeImageContent) {
          contentParams.push({
            type: "text",
            text: `<message_meta>\n${JSON.stringify({ images: promptImages.map(({ value }) => value) }, null, 2)}\n</message_meta>`,
          });
        }
        return { ...message, contentParams };
      })
    );
    return prepared;
  }

  private getLocalPromptImagePath(imageUrl: string): string | null {
    try {
      const url = new URL(imageUrl);
      return url.protocol === "file:" ? fileURLToPath(url) : null;
    } catch {
      return null;
    }
  }

  private reportNewPrompt(): void {
    const { machineId, telemetryEnabled } = this.createOpenAIClient();
    reportNewPrompt({ enabled: telemetryEnabled ?? true, machineId });
  }

  interruptActiveSession(): void {
    const controller = this.activePromptController;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }

    const sessionId = this.activeSessionId;
    if (sessionId) {
      this.interruptSession(sessionId);
    }
  }

  interruptSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    const processIds = this.getProcessIds(session?.processes ?? null);
    const killedPids: number[] = [];
    const failedPids: number[] = [];
    for (const pid of processIds) {
      const processControlKey = this.getProcessControlKey(sessionId, pid);
      this.processTimeoutControls.delete(processControlKey);
      this.liveProcessKeys.delete(processControlKey);
      if (killProcessTree(pid, "SIGKILL")) {
        killedPids.push(pid);
        continue;
      }
      failedPids.push(pid);
    }

    const controller = this.sessionControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.sessionControllers.delete(sessionId);
    }

    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "interrupted",
      failReason: "interrupted",
      processes: null,
      updateTime: now,
    }));

    const contentParts = ["Interrupted."];
    if (killedPids.length > 0) {
      contentParts.push(`Killed processes: ${killedPids.join(", ")}.`);
    }
    if (failedPids.length > 0) {
      contentParts.push(`Failed to kill processes: ${failedPids.join(", ")}.`);
    }

    this.onAssistantMessage(this.buildUserMessage(sessionId, { text: contentParts.join(" ") }), false);
  }

  private isInterrupted(sessionId: string): boolean {
    return !this.sessionControllers.has(sessionId);
  }

  /**
   * Mark a session's permission as denied by the user.
   * Updates the session entry status and failReason so the denial is visible in the session list.
   */
  denySessionPermission(sessionId: string, reason?: string): void {
    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "permission_denied",
      failReason: reason ?? "Permission denied by user",
      updateTime: now,
    }));
  }

  adjustActiveBashTimeout(deltaMs: number): BashTimeoutAdjustment | null {
    const sessionId = this.activeSessionId;
    if (!sessionId || !Number.isFinite(deltaMs)) {
      return null;
    }
    const session = this.getSession(sessionId);
    if (!session?.processes) {
      return null;
    }

    let selectedPid: string | null = null;
    for (const pid of session.processes.keys()) {
      if (this.processTimeoutControls.has(this.getProcessControlKey(sessionId, pid))) {
        selectedPid = pid;
      }
    }
    if (!selectedPid) {
      return null;
    }

    const control = this.processTimeoutControls.get(this.getProcessControlKey(sessionId, selectedPid));
    if (!control) {
      return null;
    }

    const current = control.getInfo();
    const next = control.setTimeoutMs(current.timeoutMs + deltaMs);
    this.updateSessionProcessTimeout(sessionId, selectedPid, next);
    return this.buildBashTimeoutAdjustment(selectedPid, next);
  }

  listSessions(): SessionEntry[] {
    const index = this.loadSessionsIndex();
    return index.entries;
  }

  getSession(sessionId: string): SessionEntry | null {
    const index = this.loadSessionsIndex();
    return index.entries.find((entry) => entry.id === sessionId) ?? null;
  }

  forkSession(sourceSessionId: string): string {
    const source = this.getSession(sourceSessionId);
    if (!source) {
      throw new Error(`No saved session found with ID "${sourceSessionId}".`);
    }

    const sourceMessages = this.listSessionMessages(sourceSessionId);
    const sourceMessage = sourceMessages.at(-1);
    if (!sourceMessage || typeof sourceMessage.id !== "string" || !sourceMessage.id) {
      throw new Error(`Session "${sourceSessionId}" has no messages to fork.`);
    }

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const entry: SessionEntry = {
      id: sessionId,
      summary: source.summary,
      assistantReply: source.assistantReply,
      assistantThinking: source.assistantThinking,
      assistantRefusal: null,
      toolCalls: null,
      status: "completed",
      failReason: null,
      usage: null,
      usagePerModel: null,
      activeTokens: source.activeTokens,
      intentNarrationRejections: 0,
      createTime: now,
      updateTime: now,
      processes: null,
      planMode: source.planMode,
      forkedFrom: {
        sessionId: sourceSessionId,
        messageId: sourceMessage.id,
      },
    };

    const forkedMessages = this.copySessionImagesForFork(sourceSessionId, sessionId, sourceMessages).map((message) => ({
      ...message,
      sessionId,
    }));
    this.saveSessionMessages(sessionId, forkedMessages);
    this.getFileHistory().forkSession(sourceSessionId, sessionId);

    const index = this.loadSessionsIndex();
    index.entries.push(entry);
    const sortedEntries = index.entries.slice().sort((a, b) => {
      const aTime = Date.parse(a.updateTime);
      const bTime = Date.parse(b.updateTime);
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
        return b.updateTime.localeCompare(a.updateTime);
      }
      return bTime - aTime;
    });
    const keptEntries = sortedEntries.slice(0, MAX_SESSION_ENTRIES);
    const keptIds = new Set(keptEntries.map((item) => item.id));
    const droppedEntries = sortedEntries.filter((item) => !keptIds.has(item.id));
    index.entries = keptEntries;
    this.saveSessionsIndex(index);
    for (const dropped of droppedEntries) {
      this.cleanupSessionResources(dropped.id, {
        removeMessages: true,
        processIds: this.getProcessIds(dropped.processes ?? null),
      });
    }

    return sessionId;
  }

  /**
   * Delete a session by its ID.
   * Removes the session entry from the index and cleans up associated resources
   * such as message files, in-memory state caches, working directory state,
   * session controllers, and tracked process timeout controls.
   * Returns true if the session was found and deleted, false otherwise.
   */
  deleteSession(sessionId: string): boolean {
    const index = this.loadSessionsIndex();
    const targetEntry = index.entries.find((entry) => entry.id === sessionId) ?? null;
    const nextEntries = index.entries.filter((entry) => entry.id !== sessionId);
    if (nextEntries.length === index.entries.length) {
      return false;
    }

    index.entries = nextEntries;
    this.saveSessionsIndex(index);
    this.cleanupSessionResources(sessionId, {
      removeMessages: true,
      processIds: this.getProcessIds(targetEntry?.processes ?? null),
    });
    return true;
  }

  /**
   * Rename a session by updating its summary (display title).
   * Returns true if the session was found and renamed, false otherwise.
   */
  renameSession(sessionId: string, summary: string): boolean {
    const trimmed = summary.trim();
    if (!trimmed) {
      return false;
    }
    const entry = this.getSession(sessionId);
    if (!entry) {
      return false;
    }
    this.updateSessionEntry(sessionId, (existing) => ({
      ...existing,
      summary: trimmed,
      updateTime: new Date().toISOString(),
    }));
    return true;
  }

  listSessionMessages(sessionId: string): SessionMessage[] {
    const messagePath = this.getSessionMessagesPath(sessionId);
    if (!fs.existsSync(messagePath)) {
      return [];
    }

    const raw = fs.readFileSync(messagePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const messages: SessionMessage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SessionMessage;
        messages.push(this.normalizeSessionMessage(parsed));
      } catch {
        // ignore malformed line
      }
    }
    return messages;
  }

  listUndoTargets(sessionId: string): UndoTarget[] {
    return this.listSessionMessages(sessionId)
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => this.isUndoTargetMessage(message))
      .map(({ message, index }) => ({
        message,
        index,
        canRestoreCode: Boolean(
          message.checkpointHash && this.canRestoreCheckpointHash(sessionId, message.checkpointHash)
        ),
      }));
  }

  restoreSessionConversation(sessionId: string, messageId: string): SessionMessage[] {
    const messages = this.listSessionMessages(sessionId);
    const targetIndex = messages.findIndex((message) => message.id === messageId);
    if (targetIndex === -1) {
      throw new Error("Selected message was not found in this session.");
    }

    const keptMessages = messages.slice(0, targetIndex);
    this.saveSessionMessages(sessionId, keptMessages);
    const now = new Date().toISOString();
    const latestAssistant = [...keptMessages].reverse().find((message) => message.role === "assistant");
    const latestAssistantParams = latestAssistant?.messageParams as
      | { tool_calls?: unknown[]; reasoning_content?: string }
      | null
      | undefined;

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      assistantReply: latestAssistant?.content ?? null,
      assistantThinking:
        typeof latestAssistantParams?.reasoning_content === "string" ? latestAssistantParams.reasoning_content : null,
      assistantRefusal: null,
      toolCalls: null,
      status: "completed",
      failReason: null,
      processes: null,
      updateTime: now,
    }));
    return keptMessages;
  }

  restoreSessionCode(sessionId: string, messageId: string): void {
    const message = this.listSessionMessages(sessionId).find((item) => item.id === messageId);
    if (!message) {
      throw new Error("Selected message was not found in this session.");
    }
    if (!message.checkpointHash) {
      throw new Error("Selected message has no code checkpoint.");
    }
    this.restoreCheckpointHash(sessionId, message.checkpointHash);
  }

  private normalizeSessionMessage(message: SessionMessage): SessionMessage {
    if (message.role !== "tool") {
      return message;
    }

    const nextMeta = message.meta ? { ...message.meta } : undefined;
    const normalizedParamsMd = this.buildToolParamsSnippet(nextMeta?.function ?? null);
    if (nextMeta && normalizedParamsMd) {
      nextMeta.paramsMd = normalizedParamsMd;
    }

    const normalizedResultMd = typeof message.content === "string" ? this.buildToolResultSnippet(message.content) : "";
    if (nextMeta && normalizedResultMd) {
      nextMeta.resultMd = normalizedResultMd;
    }

    return {
      ...message,
      visible: typeof message.content === "string" ? !this.isInvisibleExecution(message.content) : message.visible,
      meta: nextMeta,
    };
  }

  private getProjectStorage(): {
    projectCode: string;
    projectDir: string;
    sessionsIndexPath: string;
  } {
    const projectCode = getProjectCode(this.projectRoot);
    const projectDir = path.join(os.homedir(), ".deepcode", "projects", projectCode);
    const sessionsIndexPath = path.join(projectDir, "sessions-index.json");
    return { projectCode, projectDir, sessionsIndexPath };
  }

  private getFileHistory(): GitFileHistory {
    return new GitFileHistory(this.projectRoot, this.getFileHistoryGitDir());
  }

  private getFileHistoryGitDir(): string {
    const { projectDir } = this.getProjectStorage();
    return path.join(projectDir, "file-history", ".git");
  }

  private ensureFileHistorySession(sessionId: string): string | undefined {
    return this.getFileHistory().ensureSession(sessionId);
  }

  private getCurrentCheckpointHash(sessionId: string): string | undefined {
    return this.getFileHistory().getCurrentCheckpointHash(sessionId);
  }

  private recordUserPromptCheckpoint(sessionId: string): FileHistoryCheckpointResult {
    return this.getFileHistory().recordTrackedFilesCheckpoint(sessionId, "User prompt checkpoint");
  }

  private prepareFileMutationCheckpoint(sessionId: string, filePath: string): void {
    const fileHistory = this.getFileHistory();
    const previousHash = fileHistory.ensureSession(sessionId);
    if (!previousHash) {
      return;
    }
    this.updateLatestUserCheckpointHash(sessionId, undefined, previousHash);
    const nextHash = fileHistory.recordCheckpoint(sessionId, [filePath], "Pre-mutation checkpoint");
    if (nextHash && nextHash !== previousHash) {
      this.updateLatestUserCheckpointHash(sessionId, previousHash, nextHash);
    }
  }

  private recordFileMutationCheckpoint(sessionId: string, filePath: string): void {
    const fileHistory = this.getFileHistory();
    fileHistory.ensureSession(sessionId);
    fileHistory.recordCheckpoint(sessionId, [filePath], "File mutation checkpoint");
  }

  private updateLatestUserCheckpointHash(sessionId: string, previousHash: string | undefined, nextHash: string): void {
    const messages = this.listSessionMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || !this.isUndoTargetMessage(message)) {
        continue;
      }
      if (message.checkpointHash && message.checkpointHash !== previousHash) {
        return;
      }
      messages[index] = {
        ...message,
        checkpointHash: nextHash,
        updateTime: new Date().toISOString(),
      };
      this.saveSessionMessages(sessionId, messages);
      return;
    }
  }

  private canRestoreCheckpointHash(sessionId: string, checkpointHash: string): boolean {
    return this.getFileHistory().canRestore(sessionId, checkpointHash);
  }

  private restoreCheckpointHash(sessionId: string, checkpointHash: string): void {
    this.getFileHistory().restore(sessionId, checkpointHash);
  }

  private isUndoTargetMessage(message: SessionMessage): boolean {
    return message.role === "user" && message.visible && !message.compacted;
  }

  private ensureProjectDir(): string {
    const { projectDir } = this.getProjectStorage();
    fs.mkdirSync(projectDir, { recursive: true });
    return projectDir;
  }

  private loadSessionsIndex(): SessionsIndex {
    const { sessionsIndexPath } = this.getProjectStorage();
    this.ensureProjectDir();

    if (!fs.existsSync(sessionsIndexPath)) {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }

    try {
      const raw = fs.readFileSync(sessionsIndexPath, "utf8");
      const parsed = JSON.parse(raw) as SessionsIndex;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.map((entry) => this.normalizeSessionEntry(entry))
        : [];
      return {
        version: 1,
        entries,
        originalPath: parsed.originalPath || this.projectRoot,
      };
    } catch {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }
  }

  private saveSessionsIndex(index: SessionsIndex): void {
    const { sessionsIndexPath } = this.getProjectStorage();
    this.ensureProjectDir();
    const normalized = {
      version: 1,
      entries: index.entries.map((entry) => ({
        ...entry,
        processes: this.serializeProcesses(entry.processes),
      })),
      originalPath: this.projectRoot,
    };
    fs.writeFileSync(sessionsIndexPath, JSON.stringify(normalized, null, 2), "utf8");
  }

  private getSessionMessagesPath(sessionId: string): string {
    const { projectDir } = this.getProjectStorage();
    return path.join(projectDir, `${sessionId}.jsonl`);
  }

  private getSessionImagesDir(sessionId: string): string {
    const { projectDir } = this.getProjectStorage();
    return path.join(projectDir, "images", sessionId);
  }

  private getReadPermissionExemptPaths(sessionId: string): string[] {
    return [...this.getSkillScanRoots().map((entry) => entry.root), this.getSessionImagesDir(sessionId)];
  }

  private removeSessionMessages(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const messagePath = this.getSessionMessagesPath(sessionId);
      try {
        if (fs.existsSync(messagePath)) {
          fs.unlinkSync(messagePath);
        }
      } catch {
        // ignore delete failures
      }
    }
  }

  private cleanupSessionResources(
    sessionId: string,
    options: { removeMessages: boolean; processIds?: number[] }
  ): void {
    const processIds = options.processIds ?? [];
    for (const pid of processIds) {
      const processControlKey = this.getProcessControlKey(sessionId, pid);
      if (!this.processTimeoutControls.has(processControlKey) && !this.liveProcessKeys.has(processControlKey)) {
        continue;
      }

      this.killTrackedProcess(processControlKey, pid);
    }

    clearSessionState(sessionId);
    clearSessionWorkingDir(sessionId);
    const controller = this.sessionControllers.get(sessionId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    this.sessionControllers.delete(sessionId);
    if (options.removeMessages) {
      this.removeSessionMessages([sessionId]);
      try {
        fs.rmSync(this.getSessionImagesDir(sessionId), { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures, matching message cleanup behavior.
      }
    }
  }

  private appendSessionMessage(sessionId: string, message: SessionMessage): void {
    this.ensureProjectDir();
    const messagePath = this.getSessionMessagesPath(sessionId);
    fs.appendFileSync(messagePath, `${JSON.stringify(message)}\n`, "utf8");
  }

  private saveSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    this.ensureProjectDir();
    const messagePath = this.getSessionMessagesPath(sessionId);
    const payload = messages.map((message) => JSON.stringify(message)).join("\n");
    fs.writeFileSync(messagePath, payload ? `${payload}\n` : "", "utf8");
  }

  private updateSessionEntry(sessionId: string, updater: (entry: SessionEntry) => SessionEntry): SessionEntry | null {
    const index = this.loadSessionsIndex();
    const entryIndex = index.entries.findIndex((entry) => entry.id === sessionId);
    if (entryIndex === -1) {
      return null;
    }

    const updated = updater({ ...index.entries[entryIndex] });
    index.entries[entryIndex] = updated;
    this.saveSessionsIndex(index);
    this.onSessionEntryUpdated?.(updated);
    return updated;
  }

  private buildUserMessage(sessionId: string, prompt: UserPromptContent): SessionMessage {
    const now = new Date().toISOString();

    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: prompt.text ?? "",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
      meta: {
        userPrompt: this.cloneUserPromptForMeta(prompt),
        isAnswers: prompt.isAnswers,
      },
      checkpointHash: this.getCurrentCheckpointHash(sessionId),
    };
  }

  private preparePromptImages(sessionId: string, prompt: UserPromptContent): UserPromptContent {
    const imageUrls = prompt.imageUrls?.filter(Boolean) ?? [];
    if (imageUrls.length === 0) {
      return prompt;
    }

    const preparedUrls: string[] = [];
    const imagesDir = this.getSessionImagesDir(sessionId);
    const createdPaths: string[] = [];
    try {
      for (let index = 0; index < imageUrls.length; index += 1) {
        const imageUrl = imageUrls[index];
        if (!imageUrl.startsWith("data:")) {
          if (imageUrl.startsWith("file:")) {
            const url = new URL(imageUrl);
            fileURLToPath(url);
            preparedUrls.push(url.href);
          } else {
            preparedUrls.push(imageUrl);
          }
          continue;
        }

        const image = this.decodePersistedPromptImage(imageUrl, index);
        fs.mkdirSync(imagesDir, { recursive: true });
        const imagePath = path.join(imagesDir, `${crypto.randomUUID()}${image.extension}`);
        fs.writeFileSync(imagePath, image.buffer, { flag: "wx", mode: 0o600 });
        createdPaths.push(imagePath);
        preparedUrls.push(pathToFileURL(imagePath).href);
      }
    } catch (error) {
      for (const imagePath of createdPaths) {
        try {
          fs.unlinkSync(imagePath);
        } catch {
          // Best-effort rollback of this submission only.
        }
      }
      try {
        fs.rmdirSync(imagesDir);
      } catch {
        // Preserve directories containing images from earlier prompts.
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to save pasted image: ${message}`);
    }

    return {
      ...prompt,
      imageUrls: preparedUrls,
    };
  }

  private decodePersistedPromptImage(dataUrl: string, index: number): PersistedPromptImage {
    const match = /^data:(image\/(?:gif|jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl);
    if (!match) {
      throw new Error(`Image #${index + 1} is invalid or unsupported. Only GIF, JPEG, PNG, and WebP are supported.`);
    }

    const payload = match[2].replace(/[\r\n]/g, "");
    const buffer = Buffer.from(payload, "base64");
    const mimeType = match[1].toLowerCase();
    const extension =
      mimeType === "image/gif"
        ? ".gif"
        : mimeType === "image/png"
          ? ".png"
          : mimeType === "image/webp"
            ? ".webp"
            : ".jpg";
    return { buffer, extension };
  }

  private copySessionImagesForFork(
    sourceSessionId: string,
    targetSessionId: string,
    messages: SessionMessage[]
  ): SessionMessage[] {
    const sourceDir = this.getSessionImagesDir(sourceSessionId);
    if (!fs.existsSync(sourceDir)) {
      return messages;
    }

    const targetDir = this.getSessionImagesDir(targetSessionId);
    try {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: true });
      const replacedPaths = replaceStringValues(messages, sourceDir, targetDir);
      return replaceStringValues(
        replacedPaths,
        pathToFileURL(sourceDir).href,
        pathToFileURL(targetDir).href
      ) as SessionMessage[];
    } catch (error) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Keep the original copy error.
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to copy session images while forking: ${message}`);
    }
  }

  private appendPlanModeTransitionMessages(sessionId: string, wasEnabled: boolean, isEnabled: boolean): void {
    if (wasEnabled === isEnabled) {
      return;
    }

    if (isEnabled) {
      const prompt = getPlanModePrompt();
      if (prompt) {
        this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, prompt));
      }
      this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, PLAN_MODE_ON_STATUS_MESSAGE));
      return;
    }

    this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, PLAN_MODE_OFF_STATUS_MESSAGE));
  }

  private renderInitCommandPrompt(): string {
    const templatePath = path.join(getExtensionRoot(), "templates", "prompts", "init_command.md.ejs");
    const template = fs.readFileSync(templatePath, "utf8");
    return ejs.render(template, {
      agentsMdFile: this.getEffectiveProjectAgentsMdFile(),
    });
  }

  private getEffectiveProjectAgentsMdFile(): string | null {
    return this.loadProjectAgentInstructions()?.displayPath ?? null;
  }

  private loadProjectAgentInstructions(): { content: string; displayPath: string } | null {
    const candidatePaths = [
      {
        absolutePath: path.join(this.projectRoot, ".deepcode", "AGENTS.md"),
        displayPath: "./.deepcode/AGENTS.md",
      },
      {
        absolutePath: path.join(this.projectRoot, "AGENTS.md"),
        displayPath: "./AGENTS.md",
      },
    ];

    for (const candidatePath of candidatePaths) {
      const content = this.readNonEmptyFile(candidatePath.absolutePath);
      if (content) {
        return {
          content,
          displayPath: candidatePath.displayPath,
        };
      }
    }

    return null;
  }

  private readNonEmptyFile(filePath: string): string | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const content = fs.readFileSync(filePath, "utf8").trim();
      return content || null;
    } catch {
      return null;
    }
  }

  private loadAgentInstructions(): string | null {
    const projectInstructions = this.loadProjectAgentInstructions();
    if (projectInstructions) {
      return projectInstructions.content;
    }

    return this.readNonEmptyFile(path.join(os.homedir(), ".deepcode", "AGENTS.md"));
  }

  private buildSystemMessage(
    sessionId: string,
    content: string,
    contentParams: unknown | null = null,
    visible = false,
    meta?: MessageMeta
  ): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "system",
      content,
      contentParams,
      messageParams: null,
      compacted: false,
      visible,
      createTime: now,
      updateTime: now,
      meta,
    };
  }

  private buildFollowUpMessage(sessionId: string, message: ToolExecutionFollowUpMessage): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: message.role,
      content: message.content,
      contentParams: message.contentParams ?? null,
      messageParams: null,
      compacted: false,
      visible: message.visible ?? false,
      createTime: now,
      updateTime: now,
    };
  }

  private buildSkillMessage(sessionId: string, content: string, skill: SkillInfo): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "system",
      content,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
      meta: { skill: { ...skill, isLoaded: true } },
    };
  }

  private buildAssistantMessage(
    sessionId: string,
    content: string | null,
    toolCalls: unknown[] | null,
    reasoningContent?: string | null
  ): SessionMessage {
    const now = new Date().toISOString();
    const hasReasoningContent = reasoningContent != null;
    const messageParams: { tool_calls?: unknown[]; reasoning_content?: string } | null =
      toolCalls || hasReasoningContent ? {} : null;
    if (toolCalls) {
      messageParams!.tool_calls = toolCalls;
    }
    if (hasReasoningContent) {
      messageParams!.reasoning_content = reasoningContent;
    }
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      content,
      contentParams: null,
      messageParams,
      compacted: false,
      visible: (content || reasoningContent || "").trim() ? true : false,
      createTime: now,
      updateTime: now,
      meta: toolCalls ? { asThinking: true } : undefined,
    };
  }

  private generateToolCallId(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  private normalizeLlmToolCalls(rawToolCalls: unknown[] | null | undefined): unknown[] | null {
    if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
      return null;
    }

    const [toolCall] = rawToolCalls;
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
      return [toolCall];
    }

    const record = toolCall as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id) {
      return [toolCall];
    }

    return [
      {
        ...record,
        id: this.generateToolCallId(),
      },
    ];
  }

  private buildToolMessage(
    sessionId: string,
    toolCallId: string,
    content: string,
    toolFunction: unknown | null,
    resultMetadata?: Record<string, unknown>
  ): SessionMessage {
    const now = new Date().toISOString();
    const paramsMd = this.buildToolParamsSnippet(toolFunction);
    const resultMd = this.buildToolResultSnippet(content);
    const isInvisibleExecution = this.isInvisibleExecution(content);
    const skill = this.getToolResultSkill(resultMetadata);
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "tool",
      content,
      contentParams: null,
      messageParams: { tool_call_id: toolCallId },
      compacted: false,
      visible: !isInvisibleExecution,
      createTime: now,
      updateTime: now,
      meta: {
        function: toolFunction ?? undefined,
        paramsMd,
        resultMd,
        skill,
      },
    };
  }

  private getToolResultSkill(metadata?: Record<string, unknown>): SkillInfo | undefined {
    const skill = metadata?.skill;
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
      return undefined;
    }
    const candidate = skill as Partial<SkillInfo>;
    if (
      typeof candidate.name !== "string" ||
      typeof candidate.path !== "string" ||
      typeof candidate.description !== "string"
    ) {
      return undefined;
    }
    return {
      name: candidate.name,
      path: candidate.path,
      description: candidate.description,
      isLoaded: candidate.isLoaded === true ? true : undefined,
      allowImplicitInvocation: candidate.allowImplicitInvocation === false ? false : undefined,
    };
  }

  private async loadSkillForToolBatch(
    sessionId: string,
    skillName: string,
    loadedSkillNames: Set<string>
  ): Promise<ToolExecutionResult> {
    if (loadedSkillNames.has(skillName)) {
      return { ok: true, name: "skill", output: `Skill already loaded: ${skillName}.` };
    }
    const result = await this.loadSkillByName(sessionId, skillName);
    if (this.getToolResultSkill(result.metadata)) {
      loadedSkillNames.add(skillName);
    }
    return result;
  }

  private async appendToolMessages(
    sessionId: string,
    toolCalls: unknown[],
    options: {
      permissionOverrides?: UserToolPermission[];
      messagePermissions?: MessageToolPermission[];
    } = {}
  ): Promise<{ waitingForUser: boolean }> {
    const loadedSkillNames = new Set<string>();
    const hooks: ToolExecutionHooks = {
      signal: this.sessionControllers.get(sessionId)?.signal,
      onProcessStart: (pid, command) => this.addSessionProcess(sessionId, pid, command),
      onProcessExit: (pid) => this.removeSessionProcess(sessionId, pid),
      onProcessStdout: (pid, chunk) => this.onProcessStdout?.(Number(pid), chunk),
      onProcessTimeoutControl: (pid, control) => this.setSessionProcessTimeoutControl(sessionId, pid, control),
      onBackgroundProcessComplete: (completion) => this.addBackgroundProcessCompletionMessage(sessionId, completion),
      onBeforeFileMutation: (filePath) => this.prepareFileMutationCheckpoint(sessionId, filePath),
      onAfterFileMutation: (filePath) => this.recordFileMutationCheckpoint(sessionId, filePath),
      onPluginRateLimitExceeded: (tool) => this.recordPluginRateLimitExceeded(sessionId, tool),
      onLoadSkill: (skillName) => this.loadSkillForToolBatch(sessionId, skillName, loadedSkillNames),
      shouldStop: () => this.isInterrupted(sessionId),
    };
    const parsedToolCalls = toolCalls
      .slice(0, 1)
      .map((toolCall) => parseToolCallForPermissions(toolCall))
      .filter((toolCall): toolCall is PermissionToolCall => Boolean(toolCall));
    const toolExecutions: ToolCallExecution[] = [];
    for (const toolCall of parsedToolCalls) {
      if (hooks.shouldStop?.()) {
        break;
      }
      const blockedResult = buildPermissionToolExecution(toolCall, options);
      if (blockedResult) {
        toolExecutions.push(blockedResult);
        continue;
      }
      const executions = await this.toolExecutor.executeToolCalls(sessionId, [toolCall], hooks);
      toolExecutions.push(...executions);
    }
    if (this.isInterrupted(sessionId)) {
      return { waitingForUser: false };
    }
    let waitingForUser = false;
    const followUpMessages: SessionMessage[] = [];
    for (const execution of toolExecutions) {
      if (execution.result.awaitUserResponse === true) {
        waitingForUser = true;
      }
      const toolFunction = this.messageConverter.findToolFunction(toolCalls, execution.toolCallId);
      const toolMessage = this.buildToolMessage(
        sessionId,
        execution.toolCallId,
        execution.content,
        toolFunction,
        execution.result.name === "skill" ? execution.result.metadata : undefined
      );
      this.appendSessionMessage(sessionId, toolMessage);
      this.onAssistantMessage(toolMessage, true);

      for (const followUpMessage of execution.result.followUpMessages ?? []) {
        followUpMessages.push(this.buildFollowUpMessage(sessionId, followUpMessage));
      }
    }

    for (const followUpMessage of followUpMessages) {
      this.appendSessionMessage(sessionId, followUpMessage);
    }
    return { waitingForUser };
  }

  private cloneUserPromptForMeta(prompt: UserPromptContent): UserPromptContent {
    return {
      text: prompt.text,
      imageUrls: prompt.imageUrls ? [...prompt.imageUrls] : undefined,
      skills: prompt.skills ? prompt.skills.map((skill) => ({ ...skill })) : undefined,
      permissions: prompt.permissions ? prompt.permissions.map((permission) => ({ ...permission })) : undefined,
      alwaysAllows: prompt.alwaysAllows ? [...prompt.alwaysAllows] : undefined,
      planMode: prompt.planMode,
      isAnswers: prompt.isAnswers,
    };
  }

  private hasTrailingPendingToolCalls(sessionId: string): boolean {
    return (
      this.messageConverter.getTrailingPendingToolCallMessage(this.listSessionMessages(sessionId)).toolCalls.length > 0
    );
  }

  private async appendDeferredPermissionPrompt(
    sessionId: string,
    userPrompt: UserPromptContent | undefined,
    controller: AbortController
  ): Promise<void> {
    if (!userPrompt || this.isContinuePrompt(userPrompt)) {
      return;
    }
    const text = userPrompt.text ?? "";
    const hasUserContent =
      text.trim().length > 0 ||
      (Array.isArray(userPrompt.imageUrls) && userPrompt.imageUrls.length > 0) ||
      (Array.isArray(userPrompt.skills) && userPrompt.skills.length > 0);
    if (!hasUserContent) {
      return;
    }
    this.reportNewPrompt();
    const signal = controller.signal;
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);
    let matchedSkills: SkillInfo[] = [];
    if (userPrompt.text) {
      const skills = await this.listSkills(sessionId);
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal, sessionId });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      matchedSkills = skills.filter((skill) => skillSet.has(skill.name));
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills, sessionId);
    this.throwIfAborted(signal);
    this.appendSkillMessages(sessionId, userPrompt.skills);
    this.appendSkillCatalogMessage(
      sessionId,
      this.mergeSkillCatalog(
        this.listPreloadedSkillCatalog(sessionId),
        matchedSkills.map((skill) => ({ name: skill.name, description: skill.description }))
      )
    );
  }

  private buildToolParamsSnippet(toolFunction: unknown | null): string {
    if (!toolFunction || typeof toolFunction !== "object") {
      return "";
    }
    const args = (toolFunction as { arguments?: unknown }).arguments;
    const toolName = (toolFunction as { name?: unknown }).name;
    if (typeof args !== "string") {
      return "";
    }
    const trimmed = args.trim();
    if (!trimmed) {
      return "";
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return this.formatToolParamsSnippet(
          typeof toolName === "string" ? toolName : null,
          parsed as Record<string, unknown>
        );
      }
    } catch {
      // fall back to raw string
    }
    return trimmed;
  }

  private formatToolParamsSnippet(toolName: string | null, args: Record<string, unknown>): string {
    if (toolName === "bash") {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      if (command && description) {
        return `${command}  # ${description}`;
      }
      if (command) {
        return command;
      }
      if (description) {
        return description;
      }
    } else if (toolName === "UpdatePlan") {
      return typeof args.explanation === "string" ? args.explanation.trim() : "";
    } else if (toolName === "write") {
      return typeof args.file_path === "string" ? args.file_path.trim() : "";
    } else if (toolName === "UnderstandImage") {
      return typeof args.image_path === "string" ? args.image_path.trim() : "";
    } else if (toolName === "edit") {
      const filePath = typeof args.file_path === "string" ? args.file_path.trim() : "";
      if (filePath) {
        return filePath;
      }
      return typeof args.snippet_id === "string" ? args.snippet_id.trim() : "";
    }

    const firstKey = Object.keys(args)[0];
    if (!firstKey) {
      return "";
    }

    const value = args[firstKey];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if ((toolName === "read" || toolName === "ReadImage") && text.startsWith(this.projectRoot)) {
      return text.slice(this.projectRoot.length).replace(/^[\\/]/, "");
    }
    return text;
  }

  private buildToolResultSnippet(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return "";
    }

    const maxLength = 2000;

    try {
      const parsed = JSON.parse(content) as { output?: unknown };
      if (parsed.output !== undefined) {
        if (typeof parsed.output === "string") {
          return this.formatToolResultSnippet(parsed.output, maxLength);
        }
        return this.formatToolResultSnippet(JSON.stringify(parsed.output), maxLength);
      }
    } catch {
      // fall back to raw content
    }

    return this.formatToolResultSnippet(content, maxLength);
  }

  private formatToolResultSnippet(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}... (total ${value.length} chars)`;
  }

  private isInvisibleExecution(content: string): boolean {
    if (!content.trim()) {
      return false;
    }
    try {
      const parsed = JSON.parse(content) as { name?: unknown; ok?: unknown };
      return parsed.name === "bash" && parsed.ok !== true;
    } catch {
      return false;
    }
  }

  private maybeNotifyTaskCompletion(
    sessionId: string,
    notifyCommand: string | undefined,
    startedAt: number,
    configuredEnv: Record<string, string> = {}
  ): void {
    if (!notifyCommand) {
      return;
    }

    const session = this.getSession(sessionId);
    if (!session || (session.status !== "completed" && session.status !== "failed")) {
      return;
    }

    // Find the last assistant message body for the BODY env variable.
    let body: string | undefined;
    const messages = this.listSessionMessages(sessionId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === "assistant" && msg.content) {
        body = msg.content;
        break;
      }
    }

    launchNotifyScript(notifyCommand, Date.now() - startedAt, this.projectRoot, undefined, configuredEnv, {
      status: session.status,
      failReason: session.failReason ?? undefined,
      body,
      title: session.summary ?? undefined,
    });
  }

  private addSessionProcess(sessionId: string, processId: string | number, command: string): void {
    const now = new Date().toISOString();
    this.liveProcessKeys.add(this.getProcessControlKey(sessionId, processId));
    this.updateSessionEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      processes.set(String(processId), { startTime: now, command });
      return {
        ...entry,
        processes,
        updateTime: now,
      };
    });
  }

  private addBackgroundProcessCompletionMessage(
    sessionId: string,
    completion: {
      command: string;
      outputPath: string;
      ok: boolean;
      exitCode: number | null;
      signal: string | null;
      error?: string;
      completedAtMs: number;
      startedAtMs: number;
    }
  ): void {
    const status = completion.ok ? "completed" : "failed";
    const exitText =
      completion.exitCode !== null
        ? `exit code ${completion.exitCode}`
        : completion.signal
          ? `signal ${completion.signal}`
          : completion.error || "unknown status";
    const durationMs = Math.max(0, completion.completedAtMs - completion.startedAtMs);
    const baseContent =
      `Background command "${completion.command}" ${status} with ${exitText} ` +
      `after ${this.formatBackgroundDuration(durationMs)}. Output: ${completion.outputPath}`;
    const logTail = completion.ok ? null : this.buildBackgroundFailureLogTailSlice(completion.outputPath);
    const content = logTail ? `${baseContent}\n${logTail}` : baseContent;
    this.addSessionSystemMessage(sessionId, content, true);
  }

  private buildBackgroundFailureLogTailSlice(outputPath: string): string | null {
    const tail = this.readTextFileTail(outputPath, BACKGROUND_FAILURE_LOG_TAIL_CHARS);
    if (!tail || !tail.content) {
      return null;
    }
    const prefix = tail.truncated ? `(${tail.totalBytes} bytes)...\n` : "";
    return [
      `<background_task_failure_log path="${outputPath}">`,
      `${prefix}${tail.content}`,
      "</background_task_failure_log>",
    ].join("\n");
  }

  private readTextFileTail(
    filePath: string,
    maxChars: number
  ): { content: string; totalBytes: number; truncated: boolean } | null {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size <= 0) {
        return null;
      }
      const content = readTextFileWithMetadata(filePath).content;
      return {
        content: content.slice(-maxChars).trimEnd(),
        totalBytes: stat.size,
        truncated: content.length > maxChars,
      };
    } catch {
      return null;
    }
  }

  private formatBackgroundDuration(durationMs: number): string {
    if (durationMs < 1000) {
      return `${durationMs}ms`;
    }
    const seconds = Math.round(durationMs / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  private recordPluginRateLimitExceeded(sessionId: string, tool: PluginRateLimitedTool): void {
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      pluginRateLimitedTool: entry.pluginRateLimitedTool === "UnderstandImage" ? entry.pluginRateLimitedTool : tool,
      updateTime: new Date().toISOString(),
    }));
  }

  private removeSessionProcess(sessionId: string, processId: string | number): void {
    const now = new Date().toISOString();
    const processControlKey = this.getProcessControlKey(sessionId, processId);
    this.processTimeoutControls.delete(processControlKey);
    this.liveProcessKeys.delete(processControlKey);
    this.updateSessionEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      processes.delete(String(processId));
      return {
        ...entry,
        processes: processes.size > 0 ? processes : null,
        updateTime: now,
      };
    });
  }

  private setSessionProcessTimeoutControl(
    sessionId: string,
    processId: string | number,
    control: ProcessTimeoutControl | null
  ): void {
    const key = this.getProcessControlKey(sessionId, processId);
    if (!control) {
      this.processTimeoutControls.delete(key);
      return;
    }

    this.processTimeoutControls.set(key, control);
    this.updateSessionProcessTimeout(sessionId, processId, control.getInfo());
  }

  private updateSessionProcessTimeout(sessionId: string, processId: string | number, info: ProcessTimeoutInfo): void {
    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      const pid = String(processId);
      const processInfo = processes.get(pid);
      if (!processInfo) {
        return entry;
      }
      processes.set(pid, {
        ...processInfo,
        timeoutMs: info.timeoutMs,
        deadlineAt: new Date(info.deadlineAtMs).toISOString(),
        timedOut: info.timedOut,
      });
      return {
        ...entry,
        processes,
        updateTime: now,
      };
    });
  }

  private buildBashTimeoutAdjustment(processId: string, info: ProcessTimeoutInfo): BashTimeoutAdjustment {
    return {
      processId,
      timeoutMs: info.timeoutMs,
      deadlineAt: new Date(info.deadlineAtMs).toISOString(),
      timedOut: info.timedOut,
    };
  }

  private getProcessControlKey(sessionId: string, processId: string | number): string {
    return `${sessionId}:${String(processId)}`;
  }

  private killLiveProcesses(): void {
    for (const processControlKey of Array.from(this.liveProcessKeys)) {
      const processId = this.getProcessIdFromControlKey(processControlKey);
      if (processId === null) {
        this.liveProcessKeys.delete(processControlKey);
        continue;
      }
      this.killTrackedProcess(processControlKey, processId);
    }
  }

  private killTrackedProcess(processControlKey: string, processId: number): void {
    const killedGroup = killProcessTree(processId, "SIGKILL");
    if (!killedGroup) {
      try {
        process.kill(processId, "SIGKILL");
      } catch {
        // Ignore process-kill failures during cleanup.
      }
    }
    this.processTimeoutControls.delete(processControlKey);
    this.liveProcessKeys.delete(processControlKey);
  }

  private getProcessIdFromControlKey(processControlKey: string): number | null {
    const separatorIndex = processControlKey.lastIndexOf(":");
    const rawProcessId = separatorIndex >= 0 ? processControlKey.slice(separatorIndex + 1) : processControlKey;
    const processId = Number(rawProcessId);
    return Number.isInteger(processId) && processId > 0 ? processId : null;
  }

  private getProcessIds(processes: Map<string, SessionProcessEntry> | null): number[] {
    if (!processes) {
      return [];
    }
    const ids: number[] = [];
    for (const pid of processes.keys()) {
      const parsed = Number(pid);
      if (Number.isInteger(parsed) && parsed > 0) {
        ids.push(parsed);
      }
    }
    return ids;
  }

  private normalizeSessionEntry(entry: unknown): SessionEntry {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      id: typeof value.id === "string" ? value.id : crypto.randomUUID(),
      summary: typeof value.summary === "string" ? value.summary : null,
      assistantReply: typeof value.assistantReply === "string" ? value.assistantReply : null,
      assistantThinking: typeof value.assistantThinking === "string" ? value.assistantThinking : null,
      assistantRefusal: typeof value.assistantRefusal === "string" ? value.assistantRefusal : null,
      toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls : null,
      status: this.normalizeSessionStatus(value.status),
      failReason: typeof value.failReason === "string" ? value.failReason : null,
      usage: (value.usage as ModelUsage) ?? null,
      usagePerModel: this.normalizeUsagePerModel(value),
      activeTokens: typeof value.activeTokens === "number" ? value.activeTokens : 0,
      createTime: typeof value.createTime === "string" ? value.createTime : new Date().toISOString(),
      updateTime: typeof value.updateTime === "string" ? value.updateTime : new Date().toISOString(),
      processes: this.deserializeProcesses(value.processes),
      askPermissions: normalizeAskPermissions(value.askPermissions),
      planMode: value.planMode === true,
      pluginRateLimitedTool: this.normalizePluginRateLimitedTool(value.pluginRateLimitedTool),
      intentNarrationRejections:
        typeof value.intentNarrationRejections === "number" && value.intentNarrationRejections >= 0
          ? Math.floor(value.intentNarrationRejections)
          : 0,
      forkedFrom: this.normalizeForkedFrom(value.forkedFrom),
    };
  }

  private normalizePluginRateLimitedTool(value: unknown): PluginRateLimitedTool | undefined {
    return value === "UnderstandImage" || value === "WebSearch" ? value : undefined;
  }

  private normalizeForkedFrom(value: unknown): SessionEntry["forkedFrom"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const forkedFrom = value as Record<string, unknown>;
    if (
      typeof forkedFrom.sessionId !== "string" ||
      !forkedFrom.sessionId ||
      typeof forkedFrom.messageId !== "string" ||
      !forkedFrom.messageId
    ) {
      return undefined;
    }
    return {
      sessionId: forkedFrom.sessionId,
      messageId: forkedFrom.messageId,
    };
  }

  private normalizeSessionStatus(status: unknown): SessionStatus {
    if (
      status === "failed" ||
      status === "pending" ||
      status === "processing" ||
      status === "waiting_for_user" ||
      status === "completed" ||
      status === "interrupted" ||
      status === "ask_permission" ||
      status === "permission_denied"
    ) {
      return status;
    }
    return "pending";
  }

  private normalizeUsagePerModel(entry: Record<string, unknown>): Record<string, ModelUsage> | null {
    if (!Object.prototype.hasOwnProperty.call(entry, "usagePerModel")) {
      return null;
    }
    if (!isUsageRecord(entry.usagePerModel)) {
      return null;
    }
    const usagePerModel: Record<string, ModelUsage> = {};
    for (const [model, usage] of Object.entries(entry.usagePerModel)) {
      if (!model || !isUsageRecord(usage)) {
        continue;
      }
      usagePerModel[model] = usage as ModelUsage;
    }
    return usagePerModel;
  }

  private deserializeProcesses(value: unknown): Map<string, SessionProcessEntry> | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const processes = new Map<string, SessionProcessEntry>();
    for (const [pid, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!pid) {
        continue;
      }
      if (typeof entry === "string") {
        // Backward compatibility for old format where just stored start time
        processes.set(pid, { startTime: entry, command: "Running process..." });
      } else if (typeof entry === "object" && entry !== null) {
        const obj = entry as {
          startTime?: unknown;
          command?: unknown;
          timeoutMs?: unknown;
          deadlineAt?: unknown;
          timedOut?: unknown;
        };
        const startTime = typeof obj.startTime === "string" ? obj.startTime : new Date().toISOString();
        const command = typeof obj.command === "string" ? obj.command : "Running process...";
        processes.set(pid, {
          startTime,
          command,
          timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined,
          deadlineAt: typeof obj.deadlineAt === "string" ? obj.deadlineAt : undefined,
          timedOut: typeof obj.timedOut === "boolean" ? obj.timedOut : undefined,
        });
      }
    }
    return processes.size > 0 ? processes : null;
  }

  private serializeProcesses(
    processes: Map<string, SessionProcessEntry> | null
  ): Record<string, SessionProcessEntry> | null {
    if (!processes || processes.size === 0) {
      return null;
    }
    const serialized: Record<string, SessionProcessEntry> = {};
    for (const [pid, entry] of processes.entries()) {
      serialized[pid] = entry;
    }
    return serialized;
  }
}
