import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildNotifyEnv,
  formatDurationSeconds,
  launchNotifyScript,
  type NotifyContext,
  type NotifySpawn,
} from "../common/notify";
import {
  DEFAULT_FILE_EXPIRES_AFTER_SECONDS,
  DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
  DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
  DEFAULT_FILES_API_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_FILES_BYTES,
  DEFAULT_MODEL,
  applyModelConfigSelection,
  readDeepcodePlusApiKey,
  resolveSettings,
  resolveSettingsSources,
} from "../settings";
import { DEFAULT_INTENT_NARRATION_GUARD_SETTINGS } from "../common/intent-narration-guard";

const TEST_PROCESS_ENV = {};

test("readDeepcodePlusApiKey reads only a non-empty env key", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-plus-settings-"));
  const settingsPath = path.join(tempDir, "settings.json");

  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { PLUS_API_KEY: "  sk-plus-test  " } }));
    assert.equal(readDeepcodePlusApiKey(settingsPath), "sk-plus-test");

    for (const settings of [{}, { env: {} }, { env: { PLUS_API_KEY: "   " } }, { env: { PLUS_API_KEY: 123 } }]) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      assert.equal(readDeepcodePlusApiKey(settingsPath), undefined);
    }

    fs.writeFileSync(settingsPath, "not json");
    assert.equal(readDeepcodePlusApiKey(settingsPath), undefined);
    assert.equal(readDeepcodePlusApiKey(path.join(tempDir, "missing.json")), undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveSettings reads top-level thinkingEnabled, notify, and webSearchTool", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v3.2",
        BASE_URL: "https://example.com/v1",
        API_KEY: "sk-test",
      },
      temperature: 0.3,
      thinkingEnabled: true,
      reasoningEffort: "high",
      debugLogEnabled: true,
      notify: "  /tmp/notify.sh  ",
      webSearchTool: "  /tmp/web-search.sh  ",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.model, "deepseek-v3.2");
  assert.equal(resolved.baseURL, "https://example.com/v1");
  assert.equal(resolved.apiKey, "sk-test");
  assert.equal(resolved.temperature, 0.3);
  assert.equal(resolved.thinkingEnabled, true);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.notify, "/tmp/notify.sh");
  assert.equal(resolved.webSearchTool, "/tmp/web-search.sh");
});

test("resolveSettings defaults multimodal to default", () => {
  const resolved = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.multimodal, "default");
});

test("resolveSettings enables the intent narration guard with safe defaults", () => {
  const resolved = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.deepEqual(resolved.intentNarrationGuard, DEFAULT_INTENT_NARRATION_GUARD_SETTINGS);
});

test("resolveSettingsSources overrides and extends intent narration phrases", () => {
  const resolved = resolveSettingsSources(
    {
      intentNarrationGuard: {
        phrases: ["user phrase"],
        additionalPhrases: ["shared phrase"],
        hardStopRejections: 5,
        hardStopWindow: 8,
      },
    },
    {
      intentNarrationGuard: {
        phrases: ["project phrase"],
        additionalPhrases: ["project extension", "shared phrase"],
        instruction: "Call the tool.",
        hardStopRejections: 9,
        hardStopWindow: 7,
      },
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    { DEEPCODE_INTENT_NARRATION_GUARD_ENABLED: "false" }
  );

  assert.deepEqual(resolved.intentNarrationGuard, {
    enabled: false,
    phrases: ["project phrase", "shared phrase", "project extension"],
    instruction: "Call the tool.",
    hardStopRejections: 7,
    hardStopWindow: 7,
  });
});

test("resolveSettings applies Files API defaults", () => {
  const resolved = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.filesApiEnabled, false);
  assert.equal(resolved.filesApiTimeoutMs, DEFAULT_FILES_API_TIMEOUT_MS);
  assert.equal(resolved.fileExpiresAfterSeconds, DEFAULT_FILE_EXPIRES_AFTER_SECONDS);
  assert.equal(resolved.fileRefreshMarginSeconds, DEFAULT_FILE_REFRESH_MARGIN_SECONDS);
  assert.equal(resolved.fileQuotaCleanupBatch, DEFAULT_FILE_QUOTA_CLEANUP_BATCH);
  assert.equal(resolved.maxRequestFilesBytes, DEFAULT_MAX_REQUEST_FILES_BYTES);
});

test("resolveSettings enables Files API only for the DeepSeek API base URL", () => {
  const deepSeek = resolveSettings(
    { filesApiEnabled: true },
    { model: "default-model", baseURL: "https://api.deepseek.com" },
    TEST_PROCESS_ENV
  );
  const custom = resolveSettings(
    { env: { BASE_URL: "https://example.com/v1" }, filesApiEnabled: true },
    { model: "default-model", baseURL: "https://api.deepseek.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(deepSeek.filesApiEnabled, true);
  assert.equal(custom.filesApiEnabled, false);
});

test("resolveSettingsSources validates Files API settings and uses project precedence", () => {
  const resolved = resolveSettingsSources(
    {
      filesApiEnabled: true,
      filesApiTimeoutMs: 120_000,
      fileExpiresAfterSeconds: 86_400,
      fileRefreshMarginSeconds: 7_200,
      fileQuotaCleanupBatch: 50,
      maxRequestFilesBytes: 10_000,
    },
    {
      filesApiEnabled: false,
      filesApiTimeoutMs: 600_001,
      fileExpiresAfterSeconds: 7_200,
      fileRefreshMarginSeconds: 7_200,
      fileQuotaCleanupBatch: 200,
      maxRequestFilesBytes: 20_000,
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.filesApiEnabled, false);
  assert.equal(resolved.filesApiTimeoutMs, 120_000);
  assert.equal(resolved.fileExpiresAfterSeconds, 7_200);
  assert.equal(resolved.fileRefreshMarginSeconds, DEFAULT_FILE_REFRESH_MARGIN_SECONDS);
  assert.equal(resolved.fileQuotaCleanupBatch, 200);
  assert.equal(resolved.maxRequestFilesBytes, 20_000);
});

test("resolveSettings reads top-level multimodal and ignores invalid values", () => {
  const on = resolveSettings(
    { multimodal: "on" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  const off = resolveSettings(
    { multimodal: "off" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  const invalid = resolveSettings(
    { multimodal: "sometimes" as never },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(on.multimodal, "on");
  assert.equal(off.multimodal, "off");
  assert.equal(invalid.multimodal, "default");
});

test("resolveSettings reads MULTIMODAL from env", () => {
  const resolved = resolveSettings(
    { env: { MULTIMODAL: "off" } },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.multimodal, "off");
});

test("resolveSettings gives top-level multimodal priority over env MULTIMODAL", () => {
  const resolved = resolveSettings(
    {
      multimodal: "off",
      env: { MULTIMODAL: "on" },
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.multimodal, "off");
});

test("resolveSettingsSources applies multimodal source precedence", () => {
  const resolved = resolveSettingsSources(
    {
      env: { MULTIMODAL: "on" },
      multimodal: "off",
    },
    {
      env: { MULTIMODAL: "on" },
      multimodal: "off",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      DEEPCODE_MULTIMODAL: "on",
    }
  );

  assert.equal(resolved.multimodal, "on");
});

test("resolveSettings gives top-level model priority over env MODEL", () => {
  const resolved = resolveSettings(
    {
      model: "deepseek-v4-flash",
      env: {
        MODEL: "deepseek-v4-pro",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.model, "deepseek-v4-flash");
});

test("resolveSettings derives model-specific context window defaults", () => {
  const regular = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  const deepseekV4 = resolveSettings(
    { model: "deepseek-v4-flash-vision-exp" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(regular.contextWindow, 256 * 1024);
  assert.equal(regular.autoCompactWindow, 128 * 1024);
  assert.equal(deepseekV4.contextWindow, 1024 * 1024);
  assert.equal(deepseekV4.autoCompactWindow, 512 * 1024);
});

test("resolveSettings parses numeric and K/M context window settings", () => {
  const resolved = resolveSettings(
    {
      contextWindow: " 2m ",
      autoCompactWindow: 300_000,
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.contextWindow, 2 * 1024 * 1024);
  assert.equal(resolved.autoCompactWindow, 300_000);
});

test("resolveSettings derives auto compact window from the configured context window", () => {
  const resolved = resolveSettings(
    { contextWindow: "512K" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.contextWindow, 512 * 1024);
  assert.equal(resolved.autoCompactWindow, 256 * 1024);
});

test("resolveSettings ignores invalid windows and caps auto compact window at context window", () => {
  const invalid = resolveSettings(
    { contextWindow: "1G", autoCompactWindow: 1.5 },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  const capped = resolveSettings(
    { contextWindow: "128k", autoCompactWindow: "1M" },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );

  assert.equal(invalid.contextWindow, 256 * 1024);
  assert.equal(invalid.autoCompactWindow, 128 * 1024);
  assert.equal(capped.contextWindow, 128 * 1024);
  assert.equal(capped.autoCompactWindow, 128 * 1024);
});

test("resolveSettingsSources applies context window source precedence", () => {
  const resolved = resolveSettingsSources(
    { contextWindow: "256K", autoCompactWindow: "64K" },
    { contextWindow: "512K", autoCompactWindow: "128K" },
    { model: "default-model", baseURL: "https://default.example.com" },
    {
      DEEPCODE_CONTEXT_WINDOW: "1M",
      DEEPCODE_AUTO_COMPACT_WINDOW: "256k",
    }
  );

  assert.equal(resolved.contextWindow, 1024 * 1024);
  assert.equal(resolved.autoCompactWindow, 256 * 1024);
});

test("resolveSettingsSources skips invalid higher-priority context window values", () => {
  const resolved = resolveSettingsSources(
    { contextWindow: "256K" },
    { contextWindow: "512K" },
    { model: "default-model", baseURL: "https://default.example.com" },
    { DEEPCODE_CONTEXT_WINDOW: "invalid" }
  );

  assert.equal(resolved.contextWindow, 512 * 1024);
  assert.equal(resolved.autoCompactWindow, 256 * 1024);
});

test("resolveSettings reads TEMPERATURE, THINKING_ENABLED, REASONING_EFFORT, and DEBUG_LOG_ENABLED from env", () => {
  const resolved = resolveSettings(
    {
      env: {
        TEMPERATURE: "0.7",
        THINKING_ENABLED: "true",
        REASONING_EFFORT: "high",
        DEBUG_LOG_ENABLED: "true",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, true);
  assert.equal(resolved.temperature, 0.7);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.model, "default-model");
  assert.equal(resolved.baseURL, "https://default.example.com");
});

test("resolveSettings defaults telemetryEnabled to true", () => {
  const resolved = resolveSettings(
    {},
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.telemetryEnabled, true);
});

test("resolveSettings reads TELEMETRY_ENABLED from env", () => {
  const resolved = resolveSettings(
    { env: { TELEMETRY_ENABLED: "0" } },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.telemetryEnabled, false);
});

test("resolveSettings gives top-level telemetryEnabled priority over env TELEMETRY_ENABLED", () => {
  const resolved = resolveSettings(
    {
      telemetryEnabled: false,
      env: { TELEMETRY_ENABLED: "true" },
    },
    { model: "default-model", baseURL: "https://default.example.com" },
    TEST_PROCESS_ENV
  );
  assert.equal(resolved.telemetryEnabled, false);
});

test("resolveSettings ignores removed legacy env.THINKING", () => {
  const resolved = resolveSettings(
    {
      env: {
        THINKING: "enabled",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {}
  );

  assert.equal(resolved.thinkingEnabled, false);
});

test("resolveSettingsSources applies user, project, and DEEPCODE environment precedence", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        API_KEY: "user-key",
        MODEL: "user-env-model",
        THINKING_ENABLED: "false",
        REASONING_EFFORT: "high",
        TEMPERATURE: "0.2",
        DEBUG_LOG_ENABLED: "false",
        WEBHOOK: "user-webhook",
      },
      model: "user-top-model",
      thinkingEnabled: true,
      reasoningEffort: "max",
      temperature: 0.4,
      debugLogEnabled: true,
      telemetryEnabled: false,
    },
    {
      env: {
        API_KEY: "project-key",
        MODEL: "project-env-model",
        THINKING_ENABLED: "false",
        DEBUG_LOG_ENABLED: "false",
        TEMPERATURE: "0.6",
      },
      model: "project-top-model",
      thinkingEnabled: true,
      temperature: 0.8,
      telemetryEnabled: true,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      DEEPCODE_API_KEY: "system-key",
      DEEPCODE_MODEL: "system-model",
      DEEPCODE_THINKING_ENABLED: "false",
      DEEPCODE_REASONING_EFFORT: "high",
      DEEPCODE_TEMPERATURE: "1.2",
      DEEPCODE_DEBUG_LOG_ENABLED: "true",
      DEEPCODE_TELEMETRY_ENABLED: "false",
      DEEPCODE_WEBHOOK: "system-webhook",
    }
  );

  assert.equal(resolved.model, "system-model");
  assert.equal(resolved.apiKey, "system-key");
  assert.equal(resolved.thinkingEnabled, false);
  assert.equal(resolved.reasoningEffort, "high");
  assert.equal(resolved.temperature, 1.2);
  assert.equal(resolved.debugLogEnabled, true);
  assert.equal(resolved.telemetryEnabled, false);
  assert.equal(resolved.env.WEBHOOK, "system-webhook");
});

test("resolveSettingsSources merges permission settings", () => {
  const resolved = resolveSettingsSources(
    {
      permissions: {
        allow: ["read-in-cwd", "network"],
        ask: ["write-out-cwd"],
        defaultMode: "askAll",
        addWorkingDirs: ["../shared", "/opt/user-project", "", 42 as never],
      },
    },
    {
      permissions: {
        allow: ["write-in-cwd", "read-in-cwd"],
        deny: ["delete-out-cwd"],
        defaultMode: "allowAll",
        addWorkingDirs: ["../shared", " /opt/project "],
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.deepEqual(resolved.permissions.allow, ["read-in-cwd", "network", "write-in-cwd"]);
  assert.deepEqual(resolved.permissions.ask, ["write-out-cwd"]);
  assert.deepEqual(resolved.permissions.deny, ["delete-out-cwd"]);
  assert.equal(resolved.permissions.defaultMode, "allowAll");
  assert.deepEqual(resolved.permissions.addWorkingDirs, ["../shared", "/opt/user-project", "/opt/project"]);
});

test("resolveSettingsSources merges enabledSkills with project precedence", () => {
  const resolved = resolveSettingsSources(
    {
      enabledSkills: {
        inherited: false,
        "project-enabled": false,
        "project-disabled": true,
        invalid: "false" as never,
      },
    },
    {
      enabledSkills: {
        "project-enabled": true,
        "project-disabled": false,
        projectOnly: true,
        ignored: null as never,
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.deepEqual(resolved.enabledSkills, {
    inherited: false,
    "project-enabled": true,
    "project-disabled": false,
    projectOnly: true,
  });
});

test("resolveSettingsSources merges MCP env with documented priority", () => {
  const resolved = resolveSettingsSources(
    {
      env: {
        MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "user-global",
      },
      mcpServers: {
        github: {
          command: "node",
          args: ["user-server.js"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "user-local",
            USER_ONLY: "1",
          },
        },
      },
    },
    {
      env: {
        MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "project-global",
      },
      mcpServers: {
        github: {
          command: "python",
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "project-local",
            PROJECT_ONLY: "1",
          },
        },
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    {
      DEEPCODE_MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    }
  );

  assert.equal(resolved.mcpServers?.github?.command, "python");
  assert.deepEqual(resolved.mcpServers?.github?.args, ["user-server.js"]);
  assert.deepEqual(resolved.mcpServers?.github?.env, {
    MCP_GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    GITHUB_PERSONAL_ACCESS_TOKEN: "system-global",
    USER_ONLY: "1",
    PROJECT_ONLY: "1",
  });
});

test("resolveSettings defaults DeepSeek v4 models to thinking mode", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v4-flash-vision-exp",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, true);
});

test("resolveSettings applies thinking defaults to the default model", () => {
  const resolved = resolveSettings(
    {},
    {
      model: DEFAULT_MODEL,
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(DEFAULT_MODEL, "deepseek-v4-flash");
  assert.equal(resolved.model, DEFAULT_MODEL);
  assert.equal(resolved.thinkingEnabled, true);
});

test("resolveSettings keeps thinking mode off by default for other models", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v3.2",
      },
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, false);
});

test("resolveSettings allows explicit thinkingEnabled to override model defaults", () => {
  const resolved = resolveSettings(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: false,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.thinkingEnabled, false);
});

test("resolveSettings defaults invalid reasoning effort to max", () => {
  const resolved = resolveSettings(
    {
      reasoningEffort: "medium" as never,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.reasoningEffort, "max");
});

test("resolveSettings accepts low reasoning effort", () => {
  const resolved = resolveSettings(
    {
      reasoningEffort: "low",
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.reasoningEffort, "low");
});

test("resolveSettings ignores invalid temperature values", () => {
  const resolved = resolveSettings(
    {
      env: {
        TEMPERATURE: "hot",
      },
      temperature: 3,
    },
    {
      model: "default-model",
      baseURL: "https://default.example.com",
    },
    TEST_PROCESS_ENV
  );

  assert.equal(resolved.temperature, undefined);
});

test("applyModelConfigSelection writes model only when the effective model changes or already exists", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: false,
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: false,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "high",
    }
  );

  assert.equal(result.changed, true);
  assert.equal(result.settings.model, undefined);
  assert.equal(result.settings.thinkingEnabled, true);
  assert.equal(result.settings.reasoningEffort, "high");
});

test("applyModelConfigSelection persists a new selected model and thinking option", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
        BASE_URL: "https://api.deepseek.com",
        API_KEY: "sk-test",
      },
      thinkingEnabled: false,
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: false,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
      reasoningEffort: "high",
    }
  );

  assert.equal(result.changed, true);
  assert.equal(result.settings.env?.MODEL, "deepseek-v4-pro");
  assert.equal(result.settings.model, "deepseek-v4-flash");
  assert.equal(result.settings.thinkingEnabled, true);
  assert.equal(result.settings.reasoningEffort, "high");
});

test("applyModelConfigSelection leaves settings untouched when the effective selection is unchanged", () => {
  const result = applyModelConfigSelection(
    {
      env: {
        MODEL: "deepseek-v4-pro",
      },
      thinkingEnabled: true,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "max",
    },
    {
      model: "deepseek-v4-pro",
      thinkingEnabled: true,
      reasoningEffort: "max",
    }
  );

  assert.equal(result.changed, false);
  assert.equal(result.settings.model, undefined);
});

test("formatDurationSeconds preserves sub-second precision and trims trailing zeros", () => {
  assert.equal(formatDurationSeconds(0), "0");
  assert.equal(formatDurationSeconds(1250), "1");
  assert.equal(formatDurationSeconds(4000), "4");
});

test("buildNotifyEnv injects DURATION without context", () => {
  const env = buildNotifyEnv(2750, { HOME: "/tmp/home" });
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.DURATION, "2");
  assert.equal(env.STATUS, undefined);
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv injects STATUS, FAIL_REASON, BODY, and TITLE from context", () => {
  const context: NotifyContext = {
    status: "failed",
    failReason: "API key not found",
    body: "Hello, this is the last assistant message.",
    title: "Fix login bug",
  };
  const env = buildNotifyEnv(5000, { HOME: "/tmp/home" }, context);
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.DURATION, "5");
  assert.equal(env.STATUS, "failed");
  assert.equal(env.FAIL_REASON, "API key not found");
  assert.equal(env.BODY, "Hello, this is the last assistant message.");
  assert.equal(env.TITLE, "Fix login bug");
});

test("buildNotifyEnv omits optional context fields when not provided", () => {
  const env = buildNotifyEnv(
    1000,
    {
      HOME: "/tmp/home",
      STATUS: "stale-status",
      FAIL_REASON: "stale-failure",
      BODY: "stale-body",
      TITLE: "stale-title",
    },
    { status: "completed" }
  );
  assert.equal(env.STATUS, "completed");
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv ignores empty strings in context", () => {
  const env = buildNotifyEnv(
    1000,
    { HOME: "/tmp/home" },
    {
      status: "",
      failReason: "",
      body: "",
      title: "",
    }
  );
  assert.equal(env.STATUS, undefined);
  assert.equal(env.FAIL_REASON, undefined);
  assert.equal(env.BODY, undefined);
  assert.equal(env.TITLE, undefined);
});

test("buildNotifyEnv preserves special characters in body and title", () => {
  const context: NotifyContext = {
    body: 'Line 1\nLine 2\tindented "quoted"',
    title: "Fix: login & signup (urgent)",
  };
  const env = buildNotifyEnv(1000, {}, context);
  assert.equal(env.BODY, 'Line 1\nLine 2\tindented "quoted"');
  assert.equal(env.TITLE, "Fix: login & signup (urgent)");
});

test(
  "launchNotifyScript passes DURATION, context vars, and falls back to /bin/sh for non-executable scripts",
  { skip: process.platform === "win32" },
  () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { cwd?: string | URL; env?: NodeJS.ProcessEnv };
    }> = [];

    const spawnProcess: NotifySpawn = (command, args, options) => {
      calls.push({ command, args, options: { cwd: options.cwd, env: options.env } });

      return {
        once(event, listener) {
          if (event === "error" && calls.length === 1) {
            listener({ code: "EACCES" } as NodeJS.ErrnoException);
          }
          return this;
        },
        unref() {
          return undefined;
        },
      };
    };

    const context: NotifyContext = {
      status: "completed",
      body: "Task finished successfully.",
      title: "Fix login bug",
    };

    launchNotifyScript("/tmp/notify.sh", 2750, "/tmp/project", spawnProcess, { WEBHOOK: "configured" }, context);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.command, "/tmp/notify.sh");
    assert.deepEqual(calls[0]?.args, []);
    assert.equal(calls[0]?.options.cwd, "/tmp/project");
    assert.equal(calls[0]?.options.env?.DURATION, "2");
    assert.equal(calls[0]?.options.env?.WEBHOOK, "configured");
    assert.equal(calls[0]?.options.env?.STATUS, "completed");
    assert.equal(calls[0]?.options.env?.FAIL_REASON, undefined);
    assert.equal(calls[0]?.options.env?.BODY, "Task finished successfully.");
    assert.equal(calls[0]?.options.env?.TITLE, "Fix login bug");
    assert.equal(calls[1]?.command, "/bin/sh");
    assert.deepEqual(calls[1]?.args, ["/tmp/notify.sh"]);
    assert.equal(calls[1]?.options.cwd, "/tmp/project");
    assert.equal(calls[1]?.options.env?.DURATION, "2");
    assert.equal(calls[1]?.options.env?.STATUS, "completed");
    assert.equal(calls[1]?.options.env?.BODY, "Task finished successfully.");
    assert.equal(calls[1]?.options.env?.TITLE, "Fix login bug");
  }
);
