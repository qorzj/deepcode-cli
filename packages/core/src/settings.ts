import { DEEPSEEK_V4_MODELS, defaultsToThinkingMode, type MultimodalMode } from "./common/model-capabilities";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_INTENT_NARRATION_GUARD_SETTINGS,
  type IntentNarrationGuardSettings,
  type ResolvedIntentNarrationGuardSettings,
} from "./common/intent-narration-guard";

export type DeepcodingEnv = Record<string, string | undefined> & {
  MODEL?: string;
  BASE_URL?: string;
  API_KEY?: string;
  TEMPERATURE?: string;
  THINKING_ENABLED?: string;
  REASONING_EFFORT?: string;
  DEBUG_LOG_ENABLED?: string;
  TELEMETRY_ENABLED?: string;
  MULTIMODAL?: string;
};

export type ReasoningEffort = "low" | "high" | "max";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type PermissionScope =
  | "read-in-cwd"
  | "read-in-tmp"
  | "read-out-cwd"
  | "write-in-cwd"
  | "write-in-tmp"
  | "write-out-cwd"
  | "delete-in-cwd"
  | "delete-out-cwd"
  | "query-git-log"
  | "mutate-git-log"
  | "network"
  | "mcp";

export type PermissionDefaultMode = "allowAll" | "askAll";

export type PermissionSettings = {
  allow?: PermissionScope[];
  deny?: PermissionScope[];
  ask?: PermissionScope[];
  defaultMode?: PermissionDefaultMode;
  addWorkingDirs?: string[];
};

export type EnabledSkillsSettings = Record<string, boolean>;

export type StatusLineProviderConfig =
  | {
      type: "command";
      id?: string;
      command: string;
      cwd?: string;
      timeoutMs?: number;
      color?: string;
      newLine?: boolean;
      maxLength?: number;
    }
  | {
      type: "module";
      id?: string;
      path: string;
      timeoutMs?: number;
      color?: string;
      newLine?: boolean;
      maxLength?: number;
    };

export type StatusLineSettings = {
  enabled?: boolean;
  refreshMs?: number;
  separator?: string;
  providers?: StatusLineProviderConfig[];
};

export type ResolvedStatusLineSettings = {
  enabled: boolean;
  refreshMs: number;
  separator: string;
  providers: StatusLineProviderConfig[];
};

export type DeepcodingSettings = {
  env?: DeepcodingEnv;
  contextWindow?: number | string;
  autoCompactWindow?: number | string;
  model?: string;
  temperature?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  debugLogEnabled?: boolean;
  telemetryEnabled?: boolean;
  notify?: string;
  webSearchTool?: string;
  multimodal?: MultimodalMode;
  filesApiEnabled?: boolean;
  filesApiTimeoutMs?: number;
  fileExpiresAfterSeconds?: number;
  fileRefreshMarginSeconds?: number;
  fileQuotaCleanupBatch?: number;
  maxRequestFilesBytes?: number;
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: PermissionSettings;
  enabledSkills?: EnabledSkillsSettings;
  statusline?: StatusLineSettings;
  intentNarrationGuard?: IntentNarrationGuardSettings;
};

export type ResolvedDeepcodingSettings = {
  env: Record<string, string>;
  apiKey?: string;
  baseURL: string;
  model: string;
  contextWindow: number;
  autoCompactWindow: number;
  temperature?: number;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  debugLogEnabled: boolean;
  telemetryEnabled: boolean;
  notify?: string;
  webSearchTool?: string;
  multimodal: MultimodalMode;
  filesApiEnabled: boolean;
  filesApiTimeoutMs: number;
  fileExpiresAfterSeconds: number;
  fileRefreshMarginSeconds: number;
  fileQuotaCleanupBatch: number;
  maxRequestFilesBytes: number;
  mcpServers?: Record<string, McpServerConfig>;
  permissions: Required<PermissionSettings>;
  enabledSkills: EnabledSkillsSettings;
  statusline: ResolvedStatusLineSettings;
  intentNarrationGuard: ResolvedIntentNarrationGuardSettings;
};

export type ModelConfigSelection = {
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
};

export type SettingsProcessEnv = Record<string, string | undefined>;

const DEFAULT_CONTEXT_WINDOW = 256 * 1024;
const DEEPSEEK_V4_CONTEXT_WINDOW = 1024 * 1024;
export const DEFAULT_FILES_API_TIMEOUT_MS = 60_000;
export const DEFAULT_FILE_EXPIRES_AFTER_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_FILE_REFRESH_MARGIN_SECONDS = 60 * 60;
export const DEFAULT_FILE_QUOTA_CLEANUP_BATCH = 100;
export const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024;
export const MAX_FILES_API_TIMEOUT_MS = 10 * 60 * 1000;

export function getDefaultContextWindow(model: string): number {
  return DEEPSEEK_V4_MODELS.has(model) ? DEEPSEEK_V4_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

export function getDefaultAutoCompactWindow(model: string): number {
  return getDefaultContextWindow(model) / 2;
}

function parseTokenWindow(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const match = /^(\d+)([km])$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === "m" ? 1024 * 1024 : 1024;
  const tokens = amount * multiplier;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function firstTokenWindow(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = parseTokenWindow(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function resolveReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "low" || value === "high" || value === "max" ? value : undefined;
}

function resolveMultimodalMode(value: unknown): MultimodalMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "default" || normalized === "on" || normalized === "off") {
    return normalized;
  }
  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "enabled", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "disabled", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseTemperature(value: unknown): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw < 0 || raw > 2) {
    return undefined;
  }
  return raw;
}

function parseIntegerInRange(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function firstIntegerInRange(minimum: number, maximum: number, ...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = parseIntegerInRange(value, minimum, maximum);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const phrase = trimString(item);
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(phrase);
  }
  return result;
}

function mergeIntentNarrationGuard(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined,
  systemEnv: Record<string, string>
): ResolvedIntentNarrationGuardSettings {
  const userGuard = userSettings?.intentNarrationGuard;
  const projectGuard = projectSettings?.intentNarrationGuard;
  const basePhrases =
    normalizeStringArray(projectGuard?.phrases) ??
    normalizeStringArray(userGuard?.phrases) ??
    DEFAULT_INTENT_NARRATION_GUARD_SETTINGS.phrases;
  const additionalPhrases = [
    ...(normalizeStringArray(userGuard?.additionalPhrases) ?? []),
    ...(normalizeStringArray(projectGuard?.additionalPhrases) ?? []),
  ];
  const phrases = normalizeStringArray([...basePhrases, ...additionalPhrases]) ?? [];
  const hardStopWindow =
    firstIntegerInRange(1, 100, projectGuard?.hardStopWindow, userGuard?.hardStopWindow) ??
    DEFAULT_INTENT_NARRATION_GUARD_SETTINGS.hardStopWindow;
  const configuredHardStopRejections =
    firstIntegerInRange(0, 100, projectGuard?.hardStopRejections, userGuard?.hardStopRejections) ??
    DEFAULT_INTENT_NARRATION_GUARD_SETTINGS.hardStopRejections;

  return {
    enabled:
      parseBoolean(systemEnv.INTENT_NARRATION_GUARD_ENABLED) ??
      parseBoolean(projectGuard?.enabled) ??
      parseBoolean(userGuard?.enabled) ??
      DEFAULT_INTENT_NARRATION_GUARD_SETTINGS.enabled,
    phrases,
    instruction:
      trimString(projectGuard?.instruction) ||
      trimString(userGuard?.instruction) ||
      DEFAULT_INTENT_NARRATION_GUARD_SETTINGS.instruction,
    hardStopRejections: configuredHardStopRejections === 0 ? 0 : Math.min(configuredHardStopRejections, hardStopWindow),
    hardStopWindow,
  };
}

const VALID_PERMISSION_SCOPES = new Set<PermissionScope>([
  "read-in-cwd",
  "read-in-tmp",
  "read-out-cwd",
  "write-in-cwd",
  "write-in-tmp",
  "write-out-cwd",
  "delete-in-cwd",
  "delete-out-cwd",
  "query-git-log",
  "mutate-git-log",
  "network",
  "mcp",
]);

function normalizePermissionList(value: unknown): PermissionScope[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: PermissionScope[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !VALID_PERMISSION_SCOPES.has(item as PermissionScope)) {
      continue;
    }
    const scope = item as PermissionScope;
    if (!result.includes(scope)) {
      result.push(scope);
    }
  }
  return result;
}

function mergePermissionLists(...lists: Array<PermissionScope[] | undefined>): PermissionScope[] {
  const result: PermissionScope[] = [];
  for (const list of lists) {
    for (const scope of list ?? []) {
      if (!result.includes(scope)) {
        result.push(scope);
      }
    }
  }
  return result;
}

function normalizeWorkingDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    const directory = trimString(item);
    if (directory && !result.includes(directory)) {
      result.push(directory);
    }
  }
  return result;
}

function normalizePermissionDefaultMode(value: unknown): PermissionDefaultMode | undefined {
  return value === "allowAll" || value === "askAll" ? value : undefined;
}

function normalizePermissions(settings: PermissionSettings | null | undefined): Required<PermissionSettings> {
  return {
    allow: normalizePermissionList(settings?.allow),
    deny: normalizePermissionList(settings?.deny),
    ask: normalizePermissionList(settings?.ask),
    defaultMode: normalizePermissionDefaultMode(settings?.defaultMode) ?? "allowAll",
    addWorkingDirs: normalizeWorkingDirectories(settings?.addWorkingDirs),
  };
}

function mergePermissions(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined
): Required<PermissionSettings> {
  const userPermissions = normalizePermissions(userSettings?.permissions);
  const projectPermissions = normalizePermissions(projectSettings?.permissions);
  return {
    allow: mergePermissionLists(userPermissions.allow, projectPermissions.allow),
    deny: mergePermissionLists(userPermissions.deny, projectPermissions.deny),
    ask: mergePermissionLists(userPermissions.ask, projectPermissions.ask),
    addWorkingDirs: [...new Set([...userPermissions.addWorkingDirs, ...projectPermissions.addWorkingDirs])],
    defaultMode: projectSettings?.permissions
      ? projectPermissions.defaultMode
      : userSettings?.permissions
        ? userPermissions.defaultMode
        : "allowAll",
  };
}

function normalizeEnabledSkills(value: unknown): EnabledSkillsSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: EnabledSkillsSettings = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (!name || typeof enabled !== "boolean") {
      continue;
    }
    result[name] = enabled;
  }
  return result;
}

function mergeEnabledSkills(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined
): EnabledSkillsSettings {
  return {
    ...normalizeEnabledSkills(userSettings?.enabledSkills),
    ...normalizeEnabledSkills(projectSettings?.enabledSkills),
  };
}

const DEFAULT_STATUSLINE_REFRESH_MS = 2000;
const MIN_STATUSLINE_REFRESH_MS = 500;
const DEFAULT_STATUSLINE_SEPARATOR = " · ";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStatusLineProvider(value: unknown): StatusLineProviderConfig | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const type = value["type"];
  const idRaw = trimString(value["id"]);
  const id = idRaw || undefined;
  const timeoutRaw = value["timeoutMs"];
  const timeoutMs =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : undefined;
  const colorRaw = trimString(value["color"]);
  const color = colorRaw || undefined;
  const maxLengthRaw = value["maxLength"];
  const maxLength =
    typeof maxLengthRaw === "number" && Number.isFinite(maxLengthRaw) && maxLengthRaw > 0
      ? Math.floor(maxLengthRaw)
      : undefined;
  const newLine = value["newLine"] === true ? true : undefined;

  if (type === "command") {
    const command = trimString(value["command"]);
    if (!command) {
      return null;
    }
    const cwdRaw = trimString(value["cwd"]);
    return {
      type: "command",
      id,
      command,
      cwd: cwdRaw || undefined,
      timeoutMs,
      color,
      newLine,
      maxLength,
    };
  }
  if (type === "module") {
    const modulePath = trimString(value["path"]);
    if (!modulePath) {
      return null;
    }
    return {
      type: "module",
      id,
      path: modulePath,
      timeoutMs,
      color,
      newLine,
      maxLength,
    };
  }
  return null;
}

function normalizeStatusLine(value: unknown): StatusLineSettings | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const result: StatusLineSettings = {};
  const enabled = parseBoolean(value["enabled"]);
  if (enabled !== undefined) {
    result.enabled = enabled;
  }
  const refreshRaw = value["refreshMs"];
  if (typeof refreshRaw === "number" && Number.isFinite(refreshRaw) && refreshRaw >= MIN_STATUSLINE_REFRESH_MS) {
    result.refreshMs = Math.floor(refreshRaw);
  }
  const separator = value["separator"];
  if (typeof separator === "string") {
    result.separator = separator;
  }
  const providers = value["providers"];
  if (Array.isArray(providers)) {
    const normalized: StatusLineProviderConfig[] = [];
    for (const entry of providers) {
      const provider = normalizeStatusLineProvider(entry);
      if (provider) {
        normalized.push(provider);
      }
    }
    result.providers = normalized;
  }
  return result;
}

function mergeStatusLine(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined
): ResolvedStatusLineSettings {
  const userConfig = normalizeStatusLine(userSettings?.statusline) ?? {};
  const projectConfig = normalizeStatusLine(projectSettings?.statusline) ?? {};
  const userProviders = userConfig.providers ?? [];
  const projectProviders = projectConfig.providers ?? [];
  const projectIds = new Set(projectProviders.map((p) => p.id));
  const providers = [...userProviders.filter((p) => !projectIds.has(p.id)), ...projectProviders];
  const enabled = projectConfig.enabled ?? userConfig.enabled ?? providers.length > 0;
  const refreshMs = projectConfig.refreshMs ?? userConfig.refreshMs ?? DEFAULT_STATUSLINE_REFRESH_MS;
  const separator = projectConfig.separator ?? userConfig.separator ?? DEFAULT_STATUSLINE_SEPARATOR;
  return {
    enabled,
    refreshMs,
    separator,
    providers,
  };
}

function normalizeEnv(env: DeepcodingSettings["env"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!env) {
    return result;
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

export function collectDeepcodeEnv(processEnv: SettingsProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (!key.startsWith("DEEPCODE_") || typeof value !== "string") {
      continue;
    }
    const strippedKey = key.slice("DEEPCODE_".length);
    if (strippedKey) {
      result[strippedKey] = value;
    }
  }
  return result;
}

function extractMcpEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("MCP_")) {
      continue;
    }
    const strippedKey = key.slice("MCP_".length);
    if (strippedKey) {
      result[strippedKey] = value;
    }
  }
  return result;
}

function mergeMcpServers(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined,
  userEnv: Record<string, string>,
  projectEnv: Record<string, string>,
  systemEnv: Record<string, string>
): Record<string, McpServerConfig> | undefined {
  const userServers = userSettings?.mcpServers ?? {};
  const projectServers = projectSettings?.mcpServers ?? {};
  const serverNames = new Set([...Object.keys(userServers), ...Object.keys(projectServers)]);
  if (serverNames.size === 0) {
    return undefined;
  }

  const userMcpEnv = extractMcpEnv(userEnv);
  const projectMcpEnv = extractMcpEnv(projectEnv);
  const systemMcpEnv = extractMcpEnv(systemEnv);
  const merged: Record<string, McpServerConfig> = {};

  for (const name of serverNames) {
    const userConfig = userServers[name];
    const projectConfig = projectServers[name];
    const command = projectConfig?.command ?? userConfig?.command;
    if (!command) {
      continue;
    }

    const env = {
      ...userEnv,
      ...(userConfig?.env ?? {}),
      ...userMcpEnv,
      ...projectEnv,
      ...(projectConfig?.env ?? {}),
      ...projectMcpEnv,
      ...systemEnv,
      ...systemMcpEnv,
    };
    const config: McpServerConfig = {
      command,
      args: projectConfig?.args ?? userConfig?.args,
    };
    if (Object.keys(env).length > 0) {
      config.env = env;
    }
    merged[name] = config;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveSettingsSources(
  userSettings: DeepcodingSettings | null | undefined,
  projectSettings: DeepcodingSettings | null | undefined,
  defaults: { model: string; baseURL: string },
  processEnv: SettingsProcessEnv = process.env
): ResolvedDeepcodingSettings {
  const userEnv = normalizeEnv(userSettings?.env);
  const projectEnv = normalizeEnv(projectSettings?.env);
  const systemEnv = collectDeepcodeEnv(processEnv);
  const env = {
    ...userEnv,
    ...projectEnv,
    ...systemEnv,
  };

  const model =
    trimString(systemEnv.MODEL) ||
    trimString(projectSettings?.model) ||
    trimString(projectEnv.MODEL) ||
    trimString(userSettings?.model) ||
    trimString(userEnv.MODEL) ||
    defaults.model;
  const baseURL = trimString(env.BASE_URL) || defaults.baseURL;

  const contextWindow =
    firstTokenWindow(systemEnv.CONTEXT_WINDOW, projectSettings?.contextWindow, userSettings?.contextWindow) ??
    getDefaultContextWindow(model);
  const configuredAutoCompactWindow = firstTokenWindow(
    systemEnv.AUTO_COMPACT_WINDOW,
    projectSettings?.autoCompactWindow,
    userSettings?.autoCompactWindow
  );
  const defaultAutoCompactWindow = Math.max(1, Math.floor(contextWindow / 2));
  const autoCompactWindow = Math.min(configuredAutoCompactWindow ?? defaultAutoCompactWindow, contextWindow);

  const thinkingEnabled =
    parseBoolean(systemEnv.THINKING_ENABLED) ??
    parseBoolean(projectSettings?.thinkingEnabled) ??
    parseBoolean(projectEnv.THINKING_ENABLED) ??
    parseBoolean(userSettings?.thinkingEnabled) ??
    parseBoolean(userEnv.THINKING_ENABLED) ??
    defaultsToThinkingMode(model);

  const reasoningEffort =
    resolveReasoningEffort(systemEnv.REASONING_EFFORT) ??
    resolveReasoningEffort(projectSettings?.reasoningEffort) ??
    resolveReasoningEffort(projectEnv.REASONING_EFFORT) ??
    resolveReasoningEffort(userSettings?.reasoningEffort) ??
    resolveReasoningEffort(userEnv.REASONING_EFFORT) ??
    "max";

  const temperature =
    parseTemperature(systemEnv.TEMPERATURE) ??
    parseTemperature(projectSettings?.temperature) ??
    parseTemperature(projectEnv.TEMPERATURE) ??
    parseTemperature(userSettings?.temperature) ??
    parseTemperature(userEnv.TEMPERATURE);

  const debugLogEnabled =
    parseBoolean(systemEnv.DEBUG_LOG_ENABLED) ??
    parseBoolean(projectSettings?.debugLogEnabled) ??
    parseBoolean(projectEnv.DEBUG_LOG_ENABLED) ??
    parseBoolean(userSettings?.debugLogEnabled) ??
    parseBoolean(userEnv.DEBUG_LOG_ENABLED) ??
    false;

  const telemetryEnabled =
    parseBoolean(systemEnv.TELEMETRY_ENABLED) ??
    parseBoolean(projectSettings?.telemetryEnabled) ??
    parseBoolean(projectEnv.TELEMETRY_ENABLED) ??
    parseBoolean(userSettings?.telemetryEnabled) ??
    parseBoolean(userEnv.TELEMETRY_ENABLED) ??
    true;

  const notify =
    trimString(systemEnv.NOTIFY) || trimString(projectSettings?.notify) || trimString(userSettings?.notify) || "";
  const webSearchTool =
    trimString(systemEnv.WEB_SEARCH_TOOL) ||
    trimString(projectSettings?.webSearchTool) ||
    trimString(userSettings?.webSearchTool) ||
    "";

  const multimodal =
    resolveMultimodalMode(systemEnv.MULTIMODAL) ??
    resolveMultimodalMode(projectSettings?.multimodal) ??
    resolveMultimodalMode(projectEnv.MULTIMODAL) ??
    resolveMultimodalMode(userSettings?.multimodal) ??
    resolveMultimodalMode(userEnv.MULTIMODAL) ??
    "default";

  const filesApiEnabled =
    baseURL === DEFAULT_BASE_URL &&
    (parseBoolean(projectSettings?.filesApiEnabled) ?? parseBoolean(userSettings?.filesApiEnabled) ?? false);
  const filesApiTimeoutMs =
    firstIntegerInRange(
      1,
      MAX_FILES_API_TIMEOUT_MS,
      projectSettings?.filesApiTimeoutMs,
      userSettings?.filesApiTimeoutMs
    ) ?? DEFAULT_FILES_API_TIMEOUT_MS;
  const fileExpiresAfterSeconds =
    firstIntegerInRange(
      3_600,
      2_592_000,
      projectSettings?.fileExpiresAfterSeconds,
      userSettings?.fileExpiresAfterSeconds
    ) ?? DEFAULT_FILE_EXPIRES_AFTER_SECONDS;
  const fileRefreshMarginSeconds =
    firstIntegerInRange(
      0,
      fileExpiresAfterSeconds - 1,
      projectSettings?.fileRefreshMarginSeconds,
      userSettings?.fileRefreshMarginSeconds
    ) ?? Math.min(DEFAULT_FILE_REFRESH_MARGIN_SECONDS, fileExpiresAfterSeconds - 1);
  const fileQuotaCleanupBatch =
    firstIntegerInRange(1, 1_000, projectSettings?.fileQuotaCleanupBatch, userSettings?.fileQuotaCleanupBatch) ??
    DEFAULT_FILE_QUOTA_CLEANUP_BATCH;
  const maxRequestFilesBytes =
    firstIntegerInRange(
      1,
      Number.MAX_SAFE_INTEGER,
      projectSettings?.maxRequestFilesBytes,
      userSettings?.maxRequestFilesBytes
    ) ?? DEFAULT_MAX_REQUEST_FILES_BYTES;

  return {
    env,
    apiKey: trimString(env.API_KEY) || undefined,
    baseURL,
    model,
    contextWindow,
    autoCompactWindow,
    temperature,
    thinkingEnabled,
    reasoningEffort,
    debugLogEnabled,
    telemetryEnabled,
    notify: notify || undefined,
    webSearchTool: webSearchTool || undefined,
    multimodal,
    filesApiEnabled,
    filesApiTimeoutMs,
    fileExpiresAfterSeconds,
    fileRefreshMarginSeconds,
    fileQuotaCleanupBatch,
    maxRequestFilesBytes,
    mcpServers: mergeMcpServers(userSettings, projectSettings, userEnv, projectEnv, systemEnv),
    permissions: mergePermissions(userSettings, projectSettings),
    enabledSkills: mergeEnabledSkills(userSettings, projectSettings),
    statusline: mergeStatusLine(userSettings, projectSettings),
    intentNarrationGuard: mergeIntentNarrationGuard(userSettings, projectSettings, systemEnv),
  };
}

export function resolveSettings(
  settings: DeepcodingSettings | null | undefined,
  defaults: { model: string; baseURL: string },
  processEnv: SettingsProcessEnv = process.env
): ResolvedDeepcodingSettings {
  return resolveSettingsSources(settings, null, defaults, processEnv);
}

export function modelConfigKey(config: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">): string {
  return config.thinkingEnabled ? `thinking:${config.reasoningEffort}` : "thinking:none";
}

export function applyModelConfigSelection(
  settings: DeepcodingSettings | null | undefined,
  current: ModelConfigSelection,
  selected: ModelConfigSelection
): { settings: DeepcodingSettings; changed: boolean } {
  const changed = selected.model !== current.model || modelConfigKey(selected) !== modelConfigKey(current);
  const next: DeepcodingSettings = { ...(settings ?? {}) };

  if (!changed) {
    return { settings: next, changed: false };
  }

  if (selected.model !== current.model || Object.prototype.hasOwnProperty.call(next, "model")) {
    next.model = selected.model;
  } else {
    delete next.model;
  }

  next.thinkingEnabled = selected.thinkingEnabled;
  if (selected.thinkingEnabled) {
    next.reasoningEffort = selected.reasoningEffort;
  }

  return { settings: next, changed: true };
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

// ---------------------------------------------------------------------------
// Settings file I/O
// ---------------------------------------------------------------------------

export function getUserSettingsPath(): string {
  return path.join(os.homedir(), ".deepcode", "settings.json");
}

export function getDeepcodePlusSettingsPath(): string {
  return path.join(os.homedir(), ".deepcode-plus", "settings.json");
}

export function getProjectSettingsPath(projectRoot: string): string {
  return path.join(projectRoot, ".deepcode", "settings.json");
}

export function readDeepcodePlusApiKey(settingsPath: string = getDeepcodePlusSettingsPath()): string | undefined {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as { env?: { PLUS_API_KEY?: unknown } } | null;
    return typeof settings?.env?.PLUS_API_KEY === "string"
      ? trimString(settings.env.PLUS_API_KEY) || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

export function readSettingsFile(settingsPath: string): DeepcodingSettings | null {
  try {
    if (!fs.existsSync(settingsPath)) {
      return null;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(raw) as DeepcodingSettings;
  } catch {
    return null;
  }
}

export function readSettings(): DeepcodingSettings | null {
  return readSettingsFile(getUserSettingsPath());
}

export function readProjectSettings(projectRoot: string = process.cwd()): DeepcodingSettings | null {
  return readSettingsFile(getProjectSettingsPath(projectRoot));
}

function writeSettingsFile(settingsPath: string, settings: DeepcodingSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function writeSettings(settings: DeepcodingSettings): void {
  const settingsPath = getUserSettingsPath();
  writeSettingsFile(settingsPath, settings);
}

export function writeProjectSettings(settings: DeepcodingSettings, projectRoot: string = process.cwd()): void {
  const settingsPath = getProjectSettingsPath(projectRoot);
  writeSettingsFile(settingsPath, settings);
}

export function writeModelConfigSelection(
  selection: ModelConfigSelection,
  current: ModelConfigSelection = resolveCurrentSettings(),
  projectRoot: string = process.cwd()
): { changed: boolean; settings: DeepcodingSettings } {
  const projectSettingsPath = getProjectSettingsPath(projectRoot);
  const shouldWriteProjectSettings = fs.existsSync(projectSettingsPath);
  const rawSettings = shouldWriteProjectSettings ? readProjectSettings(projectRoot) : readSettings();
  const result = applyModelConfigSelection(rawSettings, current, selection);
  if (result.changed) {
    if (shouldWriteProjectSettings) {
      writeProjectSettings(result.settings, projectRoot);
    } else {
      writeSettings(result.settings);
    }
  }
  return result;
}

export function resolveCurrentSettings(projectRoot: string = process.cwd()): ResolvedDeepcodingSettings {
  const userPath = path.resolve(getUserSettingsPath());
  const projectPath = path.resolve(getProjectSettingsPath(projectRoot));
  const sameFile = userPath === projectPath;
  return resolveSettingsSources(
    readSettings(),
    sameFile ? null : readProjectSettings(projectRoot),
    {
      model: DEFAULT_MODEL,
      baseURL: DEFAULT_BASE_URL,
    },
    process.env
  );
}
