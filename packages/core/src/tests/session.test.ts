import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { GitFileHistory } from "../common/file-history";
import { clearSessionState } from "../common/state";
import { getSystemPrompt } from "../prompt";
import { getProjectCode, SessionManager, type SessionMessage } from "../session";
import type { MultimodalMode } from "../common/model-capabilities";

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];
const PLAN_MODE_ON_STATUS_MESSAGE = "  └ Set Plan Mode on. Awaiting <proposed_plan>.";
const PLAN_MODE_OFF_STATUS_MESSAGE = "  └ Set Plan Mode off.";

/** Set homedir in a cross-platform way (HOME on Unix, USERPROFILE on Windows). */
function setHomeDir(dir: string): void {
  process.env.HOME = dir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = dir;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalConsoleWarn;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("getProjectCode shortens long project roots for Windows-compatible storage paths", () => {
  const shortRoot = "short-project";
  assert.equal(getProjectCode(shortRoot), shortRoot.replace(/[\\/]/g, "-").replace(/:/g, ""));

  const longRoot = path.join(
    os.tmpdir(),
    "deepcode-project-code-workspace-with-a-long-name-that-would-create-long-git-internal-paths"
  );
  const projectCode = getProjectCode(longRoot);

  assert.ok(projectCode.length <= 64);
  assert.match(projectCode, /^[A-Za-z0-9._-]+$/);
  assert.notEqual(projectCode, longRoot.replace(/[\\/]/g, "-").replace(/:/g, ""));
});

test("SessionManager preserves structured user content when building OpenAI messages", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-vision-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-vision-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const messages: SessionMessage[] = [
    {
      id: "user-image",
      sessionId: "session-1",
      role: "user",
      content: "The read tool has loaded `pixel.png`.",
      contentParams: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,abc123" },
        },
      ],
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
    },
  ];

  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "test-vision-model") as Array<{
    role: string;
    content: unknown;
  }>;

  assert.equal(openAIMessages.length, 1);
  assert.equal(openAIMessages[0]?.role, "user");
  assert.deepEqual(openAIMessages[0]?.content, [
    { type: "text", text: "The read tool has loaded `pixel.png`." },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc123" },
    },
  ]);
});

test("SessionManager builds hidden user messages for image follow-ups", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const message = (manager as any).buildFollowUpMessage("session-1", {
    role: "user",
    content: "The read tool has loaded `pixel.png`.",
    contentParams: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc123" } }],
    visible: false,
  });

  assert.equal(message.role, "user");
  assert.equal(message.visible, false);
  assert.equal(message.meta, undefined);
  assert.equal(message.checkpointHash, undefined);
});

test("non-interactive SessionManager removes AskUserQuestion docs from restored requests", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    nonInteractive: true,
  });
  const now = "2026-01-01T00:00:00.000Z";
  const restoredMessages: SessionMessage[] = [
    {
      id: "old-system",
      sessionId: "restored-session",
      role: "system",
      content: getSystemPrompt(process.cwd()),
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: now,
      updateTime: now,
    },
  ];

  const prepared = (
    manager as unknown as {
      prepareSessionMessagesForRequest: (messages: SessionMessage[]) => SessionMessage[];
    }
  ).prepareSessionMessagesForRequest(restoredMessages);

  assert.equal(restoredMessages[0].content?.includes("## AskUserQuestion"), true);
  assert.equal(prepared[0].content?.includes("## AskUserQuestion"), false);
  assert.equal(prepared[0].content?.includes("## Bash"), true);
});

test("SessionManager appends failed background log tail as XML", () => {
  const workspace = createTempDir("deepcode-background-log-workspace-");
  const home = createTempDir("deepcode-background-log-home-");
  setHomeDir(home);
  const outputPath = path.join(workspace, "background.log");
  fs.writeFileSync(outputPath, ["before", "failure <line> & one", "failure line two"].join("\n"), "utf8");
  let systemMessage: SessionMessage | null = null;
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message) => {
      systemMessage = message;
    },
  });

  (manager as any).addBackgroundProcessCompletionMessage("session-background-fail", {
    command: "npm test",
    outputPath,
    ok: false,
    exitCode: 1,
    signal: null,
    startedAtMs: 0,
    completedAtMs: 1200,
  });

  assert.ok(systemMessage);
  const message = systemMessage as SessionMessage;
  assert.equal(message.role, "system");
  const content = message.content ?? "";
  assert.match(content, /Background command "npm test" failed with exit code 1/);
  assert.match(content, new RegExp(`<background_task_failure_log path="${escapeRegExp(outputPath)}">`));
  assert.match(content, /failure <line> & one[\s\S]*failure line two/);
  assert.doesNotMatch(content, /failure &lt;line&gt; &amp; one/);
  assert.doesNotMatch(content, /<output_path>/);
  assert.doesNotMatch(content, /<tail>/);
});

test("SessionManager filters image content for non-multimodal models", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "deepseek-chat",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "deepseek-chat" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const messages: SessionMessage[] = [
    {
      id: "system-image",
      sessionId: "session-1",
      role: "system",
      content: "The read tool has loaded `pixel.png`.",
      contentParams: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,abc123" },
        },
      ],
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
    },
  ];

  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "deepseek-chat") as Array<{
    role: string;
    content: unknown;
  }>;

  assert.equal(openAIMessages.length, 1);
  assert.deepEqual(openAIMessages[0]?.content, [{ type: "text", text: "The read tool has loaded `pixel.png`." }]);
});

test("SessionManager preserves empty reasoning content on assistant tool calls", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const message = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ],
    ""
  ) as SessionMessage;

  assert.deepEqual(message.messageParams, {
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ],
    reasoning_content: "",
  });

  const openAIMessages = (manager as any).buildOpenAIMessages([message], true, "test-model") as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(openAIMessages[0]?.reasoning_content, "");
});

test("SessionManager repairs legacy thinking tool calls missing reasoning content", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const messages: SessionMessage[] = [
    {
      id: "assistant-tool",
      sessionId: "session-1",
      role: "assistant",
      content: "",
      contentParams: null,
      messageParams: {
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      compacted: false,
      visible: false,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
    },
  ];

  const thinkingMessages = (manager as any).buildOpenAIMessages(messages, true, "test-model") as Array<{
    reasoning_content?: string;
  }>;
  const nonThinkingMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(thinkingMessages[0]?.reasoning_content, "");
  assert.equal(Object.prototype.hasOwnProperty.call(nonThinkingMessages[0] ?? {}, "reasoning_content"), false);
});

test("SessionManager replays normal assistant messages with reasoning content in thinking mode", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const messages: SessionMessage[] = [
    {
      id: "assistant-final",
      sessionId: "session-1",
      role: "assistant",
      content: "Final answer",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
    },
  ];

  const thinkingMessages = (manager as any).buildOpenAIMessages(messages, true, "test-model") as Array<{
    reasoning_content?: string;
  }>;
  const nonThinkingMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(thinkingMessages[0]?.reasoning_content, "");
  assert.equal(Object.prototype.hasOwnProperty.call(nonThinkingMessages[0] ?? {}, "reasoning_content"), false);
});

test("SessionManager normalizes legacy sessions without activeTokens to zero", () => {
  const workspace = createTempDir("deepcode-legacy-active-tokens-workspace-");
  const home = createTempDir("deepcode-legacy-active-tokens-home-");
  setHomeDir(home);

  const projectCode = getProjectCode(workspace);
  const projectDir = path.join(home, ".deepcode", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: [
        {
          id: "legacy-session",
          status: "completed",
          usage: { total_tokens: 123 },
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-legacy");

  assert.equal(manager.getSession("legacy-session")?.activeTokens, 0);
  assert.equal(manager.getSession("legacy-session")?.usagePerModel, null);
});

test("SessionManager keeps usagePerModel null until response usage is available", async () => {
  const workspace = createTempDir("deepcode-null-usage-per-model-workspace-");
  const home = createTempDir("deepcode-null-usage-per-model-home-");
  setHomeDir(home);

  const manager = createMockedClientSessionManager(workspace, [{ choices: [{ message: { content: "no usage" } }] }]);

  const sessionId = await manager.createSession({ text: "" });

  assert.equal(manager.getSession(sessionId)?.usage, null);
  assert.equal(manager.getSession(sessionId)?.usagePerModel, null);
});

test("SessionManager marks skills loaded from existing session messages", async () => {
  const workspace = createTempDir("deepcode-loaded-skills-workspace-");
  const home = createTempDir("deepcode-loaded-skills-home-");
  setHomeDir(home);

  const skillDir = path.join(home, ".agents", "skills", "lessweb-starter");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: lessweb-starter\ndescription: Create Lessweb projects\n---\n# Lessweb Starter\n",
    "utf8"
  );

  const projectCode = getProjectCode(workspace);
  const projectDir = path.join(home, ".deepcode", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "loaded-session.jsonl"),
    `${JSON.stringify({
      id: "skill-message",
      sessionId: "loaded-session",
      role: "system",
      content: "Use the skill document below",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
      meta: {
        skill: {
          name: "lessweb-starter",
          path: "~/.agents/skills/lessweb-starter/SKILL.md",
          description: "Create Lessweb projects",
          isLoaded: true,
        },
      },
    })}\n`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-loaded-skills");
  const loadedSkill = (await manager.listSkills("loaded-session")).find((skill) => skill.name === "lessweb-starter");

  assert.equal(loadedSkill?.isLoaded, true);
});

test("SessionManager lists skills from Deep Code and .agents roots by priority", async () => {
  const workspace = createTempDir("deepcode-project-skills-workspace-");
  const home = createTempDir("deepcode-project-skills-home-");
  setHomeDir(home);

  const userSkillDir = path.join(home, ".agents", "skills", "shared");
  fs.mkdirSync(userSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(userSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: User-level skill\n---\n# Shared\n",
    "utf8"
  );

  const userNativeSkillDir = path.join(home, ".deepcode", "skills", "native-user");
  fs.mkdirSync(userNativeSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(userNativeSkillDir, "SKILL.md"),
    "---\nname: native-user\ndescription: User .deepcode skill\n---\n# Native User\n",
    "utf8"
  );

  const userNativeSharedSkillDir = path.join(home, ".deepcode", "skills", "shared");
  fs.mkdirSync(userNativeSharedSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(userNativeSharedSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: User .deepcode skill\n---\n# Shared\n",
    "utf8"
  );

  const projectAgentsSkillDir = path.join(workspace, ".agents", "skills", "shared");
  fs.mkdirSync(projectAgentsSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectAgentsSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: Project .agents skill\n---\n# Shared\n",
    "utf8"
  );

  const projectNativeSkillDir = path.join(workspace, ".deepcode", "skills", "shared");
  fs.mkdirSync(projectNativeSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectNativeSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: Project .deepcode skill\n---\n# Shared\n",
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-project-skills");
  const skills = await manager.listSkills();
  const nativeUserSkill = skills.find((skill) => skill.name === "native-user");
  const sharedSkill = skills.find((skill) => skill.name === "shared");

  assert.equal(nativeUserSkill?.path, "~/.deepcode/skills/native-user/SKILL.md");
  assert.equal(nativeUserSkill?.description, "User .deepcode skill");
  assert.equal(sharedSkill?.path, "./.deepcode/skills/shared/SKILL.md");
  assert.equal(sharedSkill?.description, "Project .deepcode skill");
});

test("SessionManager lists bundled skills at lowest priority", async () => {
  const workspace = createTempDir("deepcode-bundled-skills-workspace-");
  const home = createTempDir("deepcode-bundled-skills-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-bundled-skills");
  const skills = await manager.listSkills();
  const skillWriter = skills.find((skill) => skill.name === "skill-writer");
  const selfRefer = skills.find((skill) => skill.name === "deepcode-self-refer");

  assert.equal(skillWriter?.path, "bundled:skill-writer/SKILL.md");
  assert.equal(selfRefer?.path, "bundled:deepcode-self-refer/SKILL.md");
  assert.match(skillWriter?.description ?? "", /Guide users through creating/);
});

test("SessionManager lets project skills override bundled skills", async () => {
  const workspace = createTempDir("deepcode-bundled-override-workspace-");
  const home = createTempDir("deepcode-bundled-override-home-");
  setHomeDir(home);

  const projectSkillDir = path.join(workspace, ".deepcode", "skills", "skill-writer");
  fs.mkdirSync(projectSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectSkillDir, "SKILL.md"),
    "---\nname: skill-writer\ndescription: Project override skill writer\n---\n# Project Skill Writer\n",
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-bundled-override");
  const skillWriter = (await manager.listSkills()).find((skill) => skill.name === "skill-writer");

  assert.equal(skillWriter?.path, "./.deepcode/skills/skill-writer/SKILL.md");
  assert.equal(skillWriter?.description, "Project override skill writer");
});

test("SessionManager resolves bundled skill prompts", () => {
  const workspace = createTempDir("deepcode-bundled-prompt-workspace-");
  const home = createTempDir("deepcode-bundled-prompt-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-bundled-prompt");
  const prompt = (manager as any).buildSkillPrompt({
    name: "skill-writer",
    path: "bundled:skill-writer/SKILL.md",
    description: "Write skills",
  });

  assert.match(prompt, /<skill_content name="skill-writer"/);
  assert.match(prompt, /# Skill Writer/);
});

test("SessionManager persists Plan Mode and appends prompts only on mode transitions", async () => {
  const workspace = createTempDir("deepcode-plan-matched-workspace-");
  const home = createTempDir("deepcode-plan-matched-home-");
  setHomeDir(home);

  const manager = createMockedClientSessionManager(workspace, [
    createChatResponse("planned", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    createChatResponse("still planning", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    createChatResponse("implementing", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);
  const sessionId = await manager.createSession({ text: "Plan this change", planMode: true });
  let messages = manager.listSessionMessages(sessionId);
  assert.equal(manager.getSession(sessionId)?.planMode, true);
  assert.equal(messages.filter((message) => message.content === PLAN_MODE_ON_STATUS_MESSAGE).length, 1);
  assert.equal(
    messages.some((message) => message.content?.includes("# Plan Mode (Conversational)")),
    true
  );
  assert.equal(messages.find((message) => message.role === "user")?.meta?.userPrompt?.planMode, true);

  await manager.replySession(sessionId, { text: "Refine it", planMode: true });
  messages = manager.listSessionMessages(sessionId);
  assert.equal(messages.filter((message) => message.content === PLAN_MODE_ON_STATUS_MESSAGE).length, 1);

  await manager.replySession(sessionId, { text: "Implement it", planMode: false });
  messages = manager.listSessionMessages(sessionId);
  assert.equal(manager.getSession(sessionId)?.planMode, false);
  assert.equal(messages.filter((message) => message.content === PLAN_MODE_OFF_STATUS_MESSAGE).length, 1);
});

test("SessionManager tags AskUserQuestion answer messages", async () => {
  const workspace = createTempDir("deepcode-answers-workspace-");
  const home = createTempDir("deepcode-answers-home-");
  setHomeDir(home);

  const manager = createMockedClientSessionManager(workspace, [
    createChatResponse("continued", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);
  const sessionId = await manager.createSession({
    text: "Questions 1/1 answered\n - Continue?\n   answer: Yes",
    isAnswers: true,
  });
  const message = manager.listSessionMessages(sessionId).find((item) => item.role === "user");

  assert.equal(message?.meta?.isAnswers, true);
  assert.equal(message?.meta?.userPrompt?.isAnswers, true);
});

test("SessionManager excludes the former bundled plan skill and defaults legacy sessions to Default mode", async () => {
  const workspace = createTempDir("deepcode-plan-legacy-workspace-");
  const home = createTempDir("deepcode-plan-legacy-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-plan-legacy");
  assert.equal(
    (await manager.listSkills()).some((skill) => skill.name === "plan"),
    false
  );

  const sessionId = await manager.createSession({ text: "Default mode" });
  const index = (manager as any).loadSessionsIndex();
  delete index.entries.find((entry: { id: string }) => entry.id === sessionId).planMode;
  (manager as any).saveSessionsIndex(index);
  assert.equal(manager.getSession(sessionId)?.planMode, false);

  const autoMatchManager = createMockedClientSessionManagerWithClient(workspace, {
    chat: {
      completions: {
        create: async (request: any) =>
          isSkillMatchingRequest(request)
            ? createSkillMatchingResponse(["plan"])
            : createChatResponse("default reply", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      },
    },
  });
  const autoMatchSessionId = await autoMatchManager.createSession({ text: "Plan this feature" });
  const autoMatchMessages = autoMatchManager.listSessionMessages(autoMatchSessionId);
  assert.equal(
    autoMatchMessages.some((message) => message.meta?.skill?.name === "plan"),
    false
  );
});

test("SessionManager excludes disabled skills by resolved skill name", async () => {
  const workspace = createTempDir("deepcode-disabled-skills-workspace-");
  const home = createTempDir("deepcode-disabled-skills-home-");
  setHomeDir(home);

  const writeSkill = (root: string, dirName: string, skillName: string): void => {
    const skillDir = path.join(root, dirName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: ${skillName} description\n---\n# ${skillName}\n`,
      "utf8"
    );
  };

  for (const root of [
    path.join(workspace, ".deepcode", "skills"),
    path.join(workspace, ".agents", "skills"),
    path.join(home, ".deepcode", "skills"),
    path.join(home, ".agents", "skills"),
  ]) {
    writeSkill(root, "skill-writer", "skill-writer");
  }
  writeSkill(path.join(workspace, ".deepcode", "skills"), "frontmatter-disabled", "renamed-disabled");
  writeSkill(path.join(workspace, ".deepcode", "skills"), "enabled-skill", "enabled-skill");

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      machineId: "machine-id-disabled-skills",
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      enabledSkills: {
        "skill-writer": false,
        "renamed-disabled": false,
        "deepcode-self-refer": false,
        "image-generator": false,
        "skill-digester": false,
        plan: false,
        "enabled-skill": true,
      },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const skills = await manager.listSkills();
  const skillNames = skills.map((skill) => skill.name);

  assert.deepEqual(skillNames, ["enabled-skill"]);
  assert.equal(skills[0]?.path, "./.deepcode/skills/enabled-skill/SKILL.md");
});

test("SessionManager keeps implicit opt-out skills available for manual invocation", async () => {
  const workspace = createTempDir("deepcode-manual-only-skill-workspace-");
  const home = createTempDir("deepcode-manual-only-skill-home-");
  setHomeDir(home);

  const skillDir = path.join(workspace, ".agents", "skills", "manual-only");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: manual-only\ndescription: Manual-only skill\nmetadata:\n  allow-implicit-invocation: false\n---\n# Manual Only\n",
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-manual-only-skill");
  const skill = (await manager.listSkills()).find((candidate) => candidate.name === "manual-only");
  assert.ok(skill);
  assert.equal(skill.allowImplicitInvocation, false);

  const sessionId = await manager.createSession({ text: "", skills: [skill] });
  const skillMessages = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system" && message.meta?.skill?.name === "manual-only");

  assert.equal(skillMessages.length, 1);
  assert.match(skillMessages[0]?.content ?? "", /<skill_content name="manual-only"/);
  assert.doesNotMatch(skillMessages[0]?.content ?? "", /allow-implicit-invocation/);
});

test("SessionManager excludes implicit opt-out skills from automatic matching candidates", async () => {
  const workspace = createTempDir("deepcode-implicit-opt-out-workspace-");
  const home = createTempDir("deepcode-implicit-opt-out-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const writeSkill = (name: string, metadata = ""): void => {
    const skillDir = path.join(workspace, ".deepcode", "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} description${metadata}\n---\n# ${name}\n`,
      "utf8"
    );
  };
  writeSkill("auto-skill");
  writeSkill("manual-only", "\nmetadata:\n  allow-implicit-invocation: false");

  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse(["manual-only", "auto-skill"]);
          }
          return createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "choose an automatic skill" });
  const matchingPrompt = String(requests[0]?.messages?.[0]?.content ?? "");

  assert.match(matchingPrompt, /"name": "auto-skill"/);
  assert.doesNotMatch(matchingPrompt, /"name": "manual-only"/);
  assert.equal(countLoadedSkillMessages(manager.listSessionMessages(sessionId), "auto-skill"), 0);
  assert.equal(countLoadedSkillMessages(manager.listSessionMessages(sessionId), "manual-only"), 0);
  const catalogMessages = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system" && Array.isArray(message.meta?.skillCatalog));
  assert.equal(catalogMessages.length, 1);
  const catalogNames = catalogMessages[0]?.meta?.skillCatalog?.map((entry) => entry.name) ?? [];
  assert.deepEqual(catalogNames, ["auto-skill"]);
  assert.equal(catalogMessages[0]?.visible, false);
  assert.match(catalogMessages[0]?.content ?? "", /<available_skills>/);
  assert.match(catalogMessages[0]?.content ?? "", /`auto-skill`/);
});

test("replySession appends the skill catalog only when content changes", async () => {
  const workspace = createTempDir("deepcode-skill-catalog-change-workspace-");
  const home = createTempDir("deepcode-skill-catalog-change-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const matchingNames: string[][] = [["skill-writer"], [], ["image-generator"]];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse(matchingNames.shift() ?? []);
          }
          return createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first turn" });
  const listCatalogMessages = () =>
    manager
      .listSessionMessages(sessionId)
      .filter((message) => message.role === "system" && Array.isArray(message.meta?.skillCatalog));

  assert.equal(listCatalogMessages().length, 1);

  await manager.replySession(sessionId, { text: "second turn with no new skill" });
  assert.equal(listCatalogMessages().length, 1);

  await manager.replySession(sessionId, { text: "third turn matches another skill" });
  const catalogs = listCatalogMessages();
  assert.equal(catalogs.length, 2);
  assert.deepEqual(catalogs[1]?.meta?.skillCatalog?.map((entry) => entry.name) ?? [], [
    "skill-writer",
    "image-generator",
  ]);
  assert.match(catalogs[1]?.content ?? "", /`skill-writer`/);
  assert.match(catalogs[1]?.content ?? "", /`image-generator`/);
});

test("skill tool stores the full document and metadata in its tool message", async () => {
  const workspace = createTempDir("deepcode-skill-load-by-name-workspace-");
  const home = createTempDir("deepcode-skill-load-by-name-home-");
  setHomeDir(home);

  const assistantMessages: SessionMessage[] = [];
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      machineId: "machine-id-skill-load-by-name",
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message) => {
      assistantMessages.push(message);
    },
  });

  const sessionId = await manager.createSession({ text: "" });
  (manager as any).sessionControllers.set(sessionId, new AbortController());
  await (manager as any).appendToolMessages(sessionId, [
    {
      id: "call-skill",
      type: "function",
      function: { name: "skill", arguments: JSON.stringify({ name: "skill-writer" }) },
    },
  ]);
  (manager as any).sessionControllers.delete(sessionId);

  const toolMessage = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "tool" && message.meta?.skill?.name === "skill-writer");
  assert.ok(toolMessage);
  const result = JSON.parse(toolMessage.content ?? "{}");
  assert.equal(result.ok, true);
  assert.equal(result.name, "skill");
  assert.match(result.output ?? "", /<skill_content name="skill-writer"/);
  assert.equal(result.metadata?.skill?.isLoaded, true);
  assert.equal(toolMessage.meta?.skill?.isLoaded, true);
  assert.equal(
    manager
      .listSessionMessages(sessionId)
      .some((message) => message.role === "system" && message.meta?.skill?.name === "skill-writer"),
    false
  );
  assert.equal(
    assistantMessages.some((message) => message.id === toolMessage.id),
    true
  );
  assert.equal((await manager.listSkills(sessionId)).find((skill) => skill.name === "skill-writer")?.isLoaded, true);
  assert.equal(
    assistantMessages.some((message) => message.role === "system" && message.meta?.skillCatalog),
    false
  );

  const missing = await (manager as any).loadSkillByName(sessionId, "not-a-real-skill");
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /Unknown skill: not-a-real-skill/);
});

test("appendToolMessages executes only the first tool in a batch", async () => {
  const workspace = createTempDir("deepcode-skill-batch-dedupe-workspace-");
  const home = createTempDir("deepcode-skill-batch-dedupe-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-skill-batch-dedupe");
  const sessionId = await manager.createSession({ text: "" });
  (manager as any).sessionControllers.set(sessionId, new AbortController());
  await (manager as any).appendToolMessages(
    sessionId,
    ["first", "second"].map((id) => ({
      id,
      type: "function",
      function: { name: "skill", arguments: JSON.stringify({ name: "skill-writer" }) },
    }))
  );
  (manager as any).sessionControllers.delete(sessionId);

  const results = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "tool")
    .map((message) => JSON.parse(message.content ?? "{}"));
  assert.equal(results.length, 1);
  assert.match(results[0]?.output ?? "", /<skill_content name="skill-writer"/);
  assert.equal(countLoadedSkillMessages(manager.listSessionMessages(sessionId), "skill-writer"), 1);
});

test("compactSession does not mark skill catalog messages compacted", async () => {
  const workspace = createTempDir("deepcode-skill-catalog-compact-workspace-");
  const home = createTempDir("deepcode-skill-catalog-compact-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse([]);
          }
          return createChatResponse("<analysis>x</analysis>\ncompact summary", {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          });
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "hello" });
  const now = new Date().toISOString();
  const append = (message: Record<string, unknown>) => (manager as any).appendSessionMessage(sessionId, message);
  append({
    id: "catalog",
    sessionId,
    role: "system",
    content: "catalog content",
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: false,
    createTime: now,
    updateTime: now,
    meta: { skillCatalog: [{ name: "skill-writer", description: "Write skills" }] },
  });
  append({
    id: "assistant-1",
    sessionId,
    role: "assistant",
    content: "first reply",
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  });
  append({
    id: "tool-1",
    sessionId,
    role: "tool",
    content: "tool result",
    contentParams: null,
    messageParams: { tool_call_id: "call-1" },
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  });
  append({
    id: "assistant-2",
    sessionId,
    role: "assistant",
    content: "final reply",
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  });

  await (manager as any).compactSession(sessionId);

  const messages = manager.listSessionMessages(sessionId);
  const catalogMessage = messages.find((message) => message.id === "catalog");
  const assistantMessage = messages.find((message) => message.id === "assistant-1");
  const toolMessage = messages.find((message) => message.id === "tool-1");

  assert.equal(catalogMessage?.compacted, false);
  assert.equal(assistantMessage?.compacted, true);
  assert.equal(toolMessage?.compacted, true);
});

test("SessionManager dispose disconnects MCP servers", async () => {
  const workspace = createTempDir("deepcode-mcp-dispose-workspace-");
  const serverPath = path.join(workspace, "mcp-server.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    if (request.params && request.params.cursor === "page-2") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [
        { name: "count", inputSchema: { type: "object", properties: {} } }
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
    ], nextCursor: "page-2" } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: request.params.name + ":" + (request.params.arguments.text || "") }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-dispose");
  const initPromise = manager.initMcpServers({ smoke: { command: process.execPath, args: [serverPath] } });

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "smoke",
      status: "starting",
      connected: false,
      toolCount: 0,
      tools: [],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ]);

  await initPromise;

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "smoke",
      status: "ready",
      connected: true,
      toolCount: 2,
      tools: ["mcp__smoke__echo", "mcp__smoke__count"],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ]);
  const mcpManager = (manager as any).mcpManager;
  assert.equal(mcpManager.getMcpToolDefinitions()[0].function.name, "mcp__smoke__echo");
  assert.deepEqual(await mcpManager.executeMcpTool("mcp__smoke__echo", { text: "ok" }), {
    ok: true,
    name: "mcp__smoke__echo",
    output: "echo:ok",
  });

  manager.dispose();

  assert.deepEqual(manager.getMcpStatus(), []);
});

test("SessionManager exposes MCP tools with API-safe names and preserves original dispatch names", async () => {
  const workspace = createTempDir("deepcode-mcp-safe-name-workspace-");
  const serverPath = path.join(workspace, "mcp-invalid-name-server.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "speak.text", description: "Speak text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "speak/text", description: "Speak text using a slash name", inputSchema: { type: "object", properties: {} } }
    ] } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: request.params.name + ":" + (request.params.arguments.text || "") }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-safe-name");
  await manager.initMcpServers({ "voice.box": { command: process.execPath, args: [serverPath] } });

  const status = manager.getMcpStatus()[0];
  assert.equal(status?.status, "ready");
  assert.deepEqual(status?.tools, ["mcp__voice_box__speak_text", "mcp__voice_box__speak_text_59a610ad"]);

  const mcpManager = (manager as any).mcpManager;
  const definitions = mcpManager.getMcpToolDefinitions();
  assert.equal(definitions[0].function.name, "mcp__voice_box__speak_text");
  assert.match(definitions[0].function.name, /^[a-zA-Z0-9_-]+$/);
  assert.match(definitions[0].function.description, /MCP source: voice\.box: speak\.text/);
  assert.deepEqual(await mcpManager.executeMcpTool("mcp__voice_box__speak_text", { text: "ok" }), {
    ok: true,
    name: "mcp__voice_box__speak_text",
    output: "speak.text:ok",
  });

  manager.dispose();
});

test("SessionManager dispose kills live processes without timeout controls", (t) => {
  if (process.platform === "win32") {
    t.skip("process group kill assertion is non-Windows specific");
    return;
  }

  const workspace = createTempDir("deepcode-dispose-process-workspace-");
  const home = createTempDir("deepcode-dispose-process-home-");
  setHomeDir(home);
  const manager = createSessionManager(workspace, "machine-id-dispose-process");
  const sessionId = createSessionAndMessages(manager, "session-dispose-process", "Dispose process session");
  const originalKill = process.kill;
  const killed: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];

  try {
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      killed.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    (manager as any).addSessionProcess(sessionId, 1234, "python3 -m http.server 8080");
    manager.dispose();
  } finally {
    process.kill = originalKill;
  }

  assert.deepEqual(killed, [{ pid: -1234, signal: "SIGKILL" }]);
});

test("SessionManager deleteSession ignores persisted processes that are not live", (t) => {
  if (process.platform === "win32") {
    t.skip("process group kill assertion is non-Windows specific");
    return;
  }

  const workspace = createTempDir("deepcode-delete-stale-process-workspace-");
  const home = createTempDir("deepcode-delete-stale-process-home-");
  setHomeDir(home);
  const manager = createSessionManager(workspace, "machine-id-delete-stale-process");
  const sessionId = createSessionAndMessages(manager, "session-delete-stale-process", "Delete stale process session");
  (manager as any).updateSessionEntry(sessionId, (entry: any) => ({
    ...entry,
    processes: new Map([["1234", { startTime: new Date().toISOString(), command: "stale process" }]]),
  }));
  const originalKill = process.kill;
  const killed: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];

  try {
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      killed.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    assert.equal(manager.deleteSession(sessionId), true);
  } finally {
    process.kill = originalKill;
  }

  assert.deepEqual(killed, []);
});

test("SessionManager refreshes cached MCP tool definitions after server crash", async () => {
  const workspace = createTempDir("deepcode-mcp-crash-cache-workspace-");
  const serverPath = path.join(workspace, "mcp-server-crash.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "echo", inputSchema: { type: "object", properties: {} } }
    ] } });
    return;
  }
  if (request.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { prompts: [] } });
    return;
  }
  if (request.method === "resources/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { resources: [] } });
    setTimeout(() => process.exit(9), 10);
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-crash-cache");
  await manager.initMcpServers({ crashy: { command: process.execPath, args: [serverPath] } });

  assert.equal(manager.getMcpStatus()[0]?.status, "ready");
  assert.equal((manager as any).mcpToolDefinitions.length, 1);

  await waitForMcpStatus(manager, "failed");

  assert.equal((manager as any).mcpToolDefinitions.length, 0);

  manager.dispose();
});

test("SessionManager reports configured MCP servers as starting before initialization", () => {
  const workspace = createTempDir("deepcode-mcp-configured-workspace-");
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  assert.deepEqual(manager.getMcpStatus(), [
    {
      name: "playwright",
      status: "starting",
      connected: false,
      toolCount: 0,
      tools: [],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ]);
});

test("SessionManager reports MCP startup stderr on failure", async () => {
  const workspace = createTempDir("deepcode-mcp-failure-workspace-");
  const serverPath = path.join(workspace, "mcp-server-fail.cjs");
  fs.writeFileSync(serverPath, 'process.stderr.write("mcp startup boom"); process.exit(7);', "utf8");

  const manager = createSessionManager(workspace, "machine-id-mcp-failure");
  await manager.initMcpServers({ broken: { command: process.execPath, args: [serverPath] } });

  const [status] = manager.getMcpStatus();
  assert.equal(status?.name, "broken");
  assert.equal(status?.status, "failed");
  assert.equal(status?.connected, false);
  assert.match(status?.error ?? "", /mcp startup boom/);
});

test(
  "SessionManager adds -y when launching MCP servers through npx",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir("deepcode-mcp-npx-workspace-");
    const argsPath = path.join(workspace, "args.json");
    const fakeNpxPath = path.join(workspace, "npx");
    fs.writeFileSync(
      fakeNpxPath,
      `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
fs.writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
      "utf8"
    );
    fs.chmodSync(fakeNpxPath, 0o755);

    const manager = createSessionManager(workspace, "machine-id-mcp-npx");
    await manager.initMcpServers({
      npxed: { command: fakeNpxPath, args: ["@playwright/mcp@latest"], env: { ARGS_PATH: argsPath } },
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")) as string[], ["-y", "@playwright/mcp@latest"]);
    manager.dispose();
  }
);

test("createSession stores /init and sends the active .deepcode project AGENTS path to the LLM", async () => {
  const workspace = createTempDir("deepcode-init-deepcode-workspace-");
  const home = createTempDir("deepcode-init-deepcode-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.mkdirSync(path.join(workspace, ".deepcode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".deepcode", "AGENTS.md"), "deepcode project instructions", "utf8");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-deepcode");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessage = messages.find((message) => message.role === "user");
  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    role: string;
    content: string;
  }>;
  const openAIUserMessage = openAIMessages.find((message) => message.role === "user");
  const systemContents = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");

  assert.equal(userMessage?.content, "/init");
  assert.match(openAIUserMessage?.content ?? "", /Update \.\/\.deepcode\/AGENTS\.md/);
  assert.doesNotMatch(openAIUserMessage?.content ?? "", /Update \.\/AGENTS\.md/);
  assert.ok(systemContents.includes("deepcode project instructions"));
  assert.ok(!systemContents.includes("root project instructions"));
});

test("createSession appends default system prompts in prefix-cache-friendly order", async () => {
  const workspace = createTempDir("deepcode-system-order-workspace-");
  const home = createTempDir("deepcode-system-order-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-system-order");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "hello" });
  const systemContents = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");

  assert.equal(systemContents.length >= 3, true);
  assert.match(systemContents[0] ?? "", /# Available Tools/);
  assert.doesNotMatch(systemContents[0] ?? "", /# Local Workspace Environment/);
  assert.doesNotMatch(systemContents[0] ?? "", /当前LLM模型为test-model/);
  assert.match(systemContents[1] ?? "", /# Local Workspace Environment/);
  assert.match(systemContents[1] ?? "", /当前LLM模型为test-model/);
  const environmentJsonMatch = (systemContents[1] ?? "").match(/```json\n([\s\S]+?)\n```/);
  assert.ok(environmentJsonMatch);
  const environmentInfo = JSON.parse(environmentJsonMatch[1] ?? "{}") as { "root path"?: string };
  assert.equal(environmentInfo["root path"], workspace);
  assert.equal(systemContents[2], "root project instructions");
});

test("createSession includes agent instructions in the skill matching system prompt", async () => {
  const workspace = createTempDir("deepcode-skill-match-create-workspace-");
  const home = createTempDir("deepcode-skill-match-create-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.mkdirSync(path.join(workspace, ".deepcode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".deepcode", "AGENTS.md"), "prefer project-specific skill matching", "utf8");
  const skillDir = path.join(workspace, ".deepcode", "skills", "project-aware");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: project-aware\ndescription: Match project-specific instructions\n---\n# Project Aware\n",
    "utf8"
  );

  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          return { choices: [{ message: { content: '{"skillNames":[]}' } }] };
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  (manager as any).activateSession = async () => {};

  await manager.createSession({ text: "pick the right workflow" });

  const messages = (requests[0]?.messages ?? []) as Array<{ role?: string; content?: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /<agent-instructions>/);
  assert.match(messages[0]?.content ?? "", /prefer project-specific skill matching/);
  assert.match(messages[0]?.content ?? "", /<\/agent-instructions>/);
  assert.match(messages[0]?.content ?? "", /The candidate skills are as follows/);
  assert.equal(messages[1]?.role, "user");
});

test("replySession includes current agent instructions in the skill matching system prompt", async () => {
  const workspace = createTempDir("deepcode-skill-match-reply-workspace-");
  const home = createTempDir("deepcode-skill-match-reply-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          return { choices: [{ message: { content: '{"skillNames":[]}' } }] };
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "" });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "use reply-time agent instructions", "utf8");
  const skillDir = path.join(workspace, ".agents", "skills", "reply-aware");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: reply-aware\ndescription: Match reply-time instructions\n---\n# Reply Aware\n",
    "utf8"
  );

  await manager.replySession(sessionId, { text: "pick the reply workflow" });

  const messages = (requests[0]?.messages ?? []) as Array<{ role?: string; content?: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /<agent-instructions>/);
  assert.match(messages[0]?.content ?? "", /use reply-time agent instructions/);
  assert.match(messages[0]?.content ?? "", /<\/agent-instructions>/);
  assert.match(messages[0]?.content ?? "", /The candidate skills are as follows/);
  assert.equal(messages[1]?.role, "user");
});

test("replySession stores /init and sends the active root project AGENTS path to the LLM", async () => {
  const workspace = createTempDir("deepcode-init-root-workspace-");
  const home = createTempDir("deepcode-init-root-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "root project instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-root");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  await manager.replySession(sessionId, { text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessages = messages.filter((message) => message.role === "user");
  const replyMessage = userMessages[userMessages.length - 1];
  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    role: string;
    content: string;
  }>;
  const openAIUserMessages = openAIMessages.filter((message) => message.role === "user");
  const openAIReplyMessage = openAIUserMessages[openAIUserMessages.length - 1];

  assert.equal(replyMessage?.content, "/init");
  assert.match(openAIReplyMessage?.content ?? "", /Update \.\/AGENTS\.md/);
});

test("createSession stores /init and sends generate prompt when no project AGENTS file is effective", async () => {
  const workspace = createTempDir("deepcode-init-generate-workspace-");
  const home = createTempDir("deepcode-init-generate-home-");
  setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  fs.mkdirSync(path.join(home, ".deepcode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".deepcode", "AGENTS.md"), "user instructions", "utf8");

  const manager = createSessionManager(workspace, "machine-id-init-generate");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "/init" });
  const messages = manager.listSessionMessages(sessionId);
  const userMessage = messages.find((message) => message.role === "user");
  const openAIMessages = (manager as any).buildOpenAIMessages(messages, false, "test-model") as Array<{
    role: string;
    content: string;
  }>;
  const openAIUserMessage = openAIMessages.find((message) => message.role === "user");

  assert.equal(userMessage?.content, "/init");
  assert.match(openAIUserMessage?.content ?? "", /Generate a file named \.\/AGENTS\.md/);
  assert.doesNotMatch(openAIUserMessage?.content ?? "", /Update \.\/AGENTS\.md/);
});

test("createSession reports a new prompt with the machineId token", async () => {
  const workspace = createTempDir("deepcode-session-workspace-");
  const home = createTempDir("deepcode-session-home-");
  setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-123");
  const activatedSessionIds: string[] = [];
  (manager as any).activateSession = async (sessionId: string) => {
    activatedSessionIds.push(sessionId);
  };

  const sessionId = await manager.createSession({ text: "hello world" });
  await flushPromises();

  assert.equal(activatedSessionIds.length, 1);
  assert.equal(activatedSessionIds[0], sessionId);
  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), "https://deepcode.vegamo.cn/api/plugin/new");
  assert.equal(fetchCalls[0].init?.method, "POST");
  assert.ok(fetchCalls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {});
  assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Token, "machine-id-123");
});

test("replySession reports a new prompt with the machineId token", async () => {
  const workspace = createTempDir("deepcode-reply-workspace-");
  const home = createTempDir("deepcode-reply-home-");
  setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-456");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  await flushPromises();
  fetchCalls.length = 0;

  await manager.replySession(sessionId, { text: "second prompt" });
  await flushPromises();

  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].input), "https://deepcode.vegamo.cn/api/plugin/new");
  assert.equal(fetchCalls[0].init?.method, "POST");
  assert.ok(fetchCalls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {});
  assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Token, "machine-id-456");
});

test("reporting a new prompt does not warn when the background request fails", async () => {
  const workspace = createTempDir("deepcode-report-failure-workspace-");
  const home = createTempDir("deepcode-report-failure-home-");
  setHomeDir(home);

  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  globalThis.fetch = (async () => {
    throw new Error("fetch failed");
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-failure");
  (manager as any).activateSession = async () => {};

  await manager.createSession({ text: "hello world" });
  await flushPromises();

  assert.deepEqual(warnings, []);
});

test(
  "SessionManager notifies successful completion with session context",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir("deepcode-notify-success-workspace-");
    const home = createTempDir("deepcode-notify-success-home-");
    setHomeDir(home);

    const notifyOutput = path.join(workspace, "notify.jsonl");
    const notifyScript = createNotifyRecorderScript(workspace);
    const manager = createNotifyingSessionManager(
      workspace,
      [createChatResponse("final answer", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })],
      notifyScript,
      notifyOutput
    );

    await manager.createSession({ text: "notify success" });

    const records = await waitForNotifyRecords(notifyOutput, 1);
    assert.equal(records[0]?.STATUS, "completed");
    assert.equal(records[0]?.FAIL_REASON, null);
    assert.equal(records[0]?.BODY, "final answer");
    assert.equal(records[0]?.TITLE, "notify success");
    assert.match(String(records[0]?.DURATION), /^\d+$/);
  }
);

test(
  "SessionManager notifies failed completion with failure context",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir("deepcode-notify-failure-workspace-");
    const home = createTempDir("deepcode-notify-failure-home-");
    setHomeDir(home);

    const notifyOutput = path.join(workspace, "notify.jsonl");
    const notifyScript = createNotifyRecorderScript(workspace);
    const manager = createNotifyingSessionManager(
      workspace,
      [
        createChatResponse("first answer", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        new Error("second request failed"),
      ],
      notifyScript,
      notifyOutput
    );

    const sessionId = await manager.createSession({ text: "notify failure" });
    await waitForNotifyRecords(notifyOutput, 1);
    await manager.replySession(sessionId, { text: "second prompt" });

    const records = await waitForNotifyRecords(notifyOutput, 2);
    const failedRecord = records[1];
    assert.equal(failedRecord?.STATUS, "failed");
    assert.equal(failedRecord?.FAIL_REASON, "second request failed");
    assert.equal(failedRecord?.BODY, "first answer");
    assert.notEqual(failedRecord?.BODY, "stale-body");
    assert.equal(failedRecord?.TITLE, "notify failure");
  }
);

test("replySession continues without appending /continue as a user message", async () => {
  const workspace = createTempDir("deepcode-continue-workspace-");
  const home = createTempDir("deepcode-continue-home-");
  setHomeDir(home);

  const fetchCalls: Array<{ input: string | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return {
      ok: true,
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-continue");
  const activatedSessionIds: string[] = [];
  (manager as any).activateSession = async (sessionId: string) => {
    activatedSessionIds.push(sessionId);
  };

  const sessionId = await manager.createSession({ text: "first prompt" });
  await flushPromises();
  const messagesBefore = manager.listSessionMessages(sessionId);
  fetchCalls.length = 0;
  activatedSessionIds.length = 0;

  await manager.replySession(sessionId, { text: "/continue" });
  await flushPromises();

  const messagesAfter = manager.listSessionMessages(sessionId);
  const userMessages = messagesAfter.filter((message) => message.role === "user");

  assert.equal(activatedSessionIds.length, 1);
  assert.equal(activatedSessionIds[0], sessionId);
  assert.equal(messagesAfter.length, messagesBefore.length);
  assert.equal(
    userMessages.some((message) => message.content === "/continue"),
    false
  );
  assert.equal(fetchCalls.length, 0);
});

test("replySession records the current file-history branch head as checkpointHash", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-checkpoint-hash-workspace-");
  const home = createTempDir("deepcode-checkpoint-hash-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-checkpoint-hash");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const checkpointHash = createFileHistoryCommit(home, workspace, sessionId, { "note.txt": "checkpoint\n" });

  await manager.replySession(sessionId, { text: "second prompt" });

  const userMessages = manager.listSessionMessages(sessionId).filter((message) => message.role === "user");
  assert.equal(userMessages[userMessages.length - 1]?.checkpointHash, checkpointHash);
});

test("createSession initializes file-history repo and session branch", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-file-history-init-workspace-");
  const home = createTempDir("deepcode-file-history-init-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-file-history-init");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  const gitDir = path.join(home, ".deepcode", "projects", getProjectCode(workspace), "file-history", ".git");

  assert.ok(fs.existsSync(gitDir));
  assert.ok(userMessage?.checkpointHash);
  assert.equal(
    runFileHistoryGit(gitDir, workspace, ["rev-parse", "--verify", `refs/heads/${sessionId}^{commit}`]).trim(),
    userMessage.checkpointHash
  );
});

test("createSession initializes an empty file-history manifest without scanning existing files", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-file-history-empty-init-workspace-");
  const home = createTempDir("deepcode-file-history-empty-init-home-");
  setHomeDir(home);
  fs.writeFileSync(path.join(workspace, "unrelated.txt"), "keep me\n", "utf8");
  fs.mkdirSync(path.join(workspace, "nested"));
  fs.writeFileSync(path.join(workspace, "nested", "another.txt"), "also keep me\n", "utf8");

  const manager = createSessionManager(workspace, "machine-id-file-history-empty-init");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  assert.ok(userMessage?.checkpointHash);

  const manifest = readFileHistoryManifest(home, workspace, userMessage.checkpointHash);
  assert.deepEqual(manifest.files, {});
});

test("replySession snapshots manual edits to tracked files before appending the user prompt", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-prompt-checkpoint-manual-edit-workspace-");
  const home = createTempDir("deepcode-prompt-checkpoint-manual-edit-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "hello_world.py");
  const manager = createSessionManager(workspace, "machine-id-prompt-checkpoint-manual-edit");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "create hello world" });
  const gitDir = getFileHistoryGitDir(home, workspace);
  const fileHistory = new GitFileHistory(workspace, gitDir);

  fs.writeFileSync(filePath, 'print("Hello, World!")\n', "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "created hello world"));

  const manualEdit = 'if name == main:\n  print("Hello, World!")\n';
  fs.writeFileSync(filePath, manualEdit, "utf8");
  await manager.replySession(sessionId, { text: "I manually edited @hello_world.py, note it" });
  const manualEditUserMessage = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "user")
    .at(-1);
  assert.ok(manualEditUserMessage?.checkpointHash);

  fs.writeFileSync(filePath, 'if __name__ == "__main__":\n  print("Hello, World!")\n', "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "fixed hello world"));

  manager.restoreSessionCode(sessionId, manualEditUserMessage.id);

  assert.equal(fs.readFileSync(filePath, "utf8"), manualEdit);
});

test("replySession inserts hidden system notice for manually changed tracked files", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-manual-change-notice-workspace-");
  const home = createTempDir("deepcode-manual-change-notice-home-");
  setHomeDir(home);

  const firstPath = path.join(workspace, "a.txt");
  const secondPath = path.join(workspace, "b.txt");
  const manager = createSessionManager(workspace, "machine-id-manual-change-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(firstPath, "one\n", "utf8");
  fs.writeFileSync(secondPath, "two\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [secondPath, firstPath], "track files"));

  fs.writeFileSync(secondPath, "two changed\n", "utf8");
  fs.writeFileSync(firstPath, "one changed\n", "utf8");
  await manager.replySession(sessionId, { text: "check manual changes" });

  const messages = manager.listSessionMessages(sessionId);
  const userIndex = messages.findIndex(
    (message) => message.role === "user" && message.content === "check manual changes"
  );
  assert.ok(userIndex > 0);
  const notice = messages[userIndex - 1];
  assert.equal(notice?.role, "system");
  assert.equal(notice?.visible, false);
  assert.equal(notice?.content, `Note that the user manually modified these files:\n${firstPath}\n${secondPath}`);
});

test("replySession does not insert manual-change notice when tracked files are unchanged", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-no-manual-change-notice-workspace-");
  const home = createTempDir("deepcode-no-manual-change-notice-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "tracked.txt");
  const manager = createSessionManager(workspace, "machine-id-no-manual-change-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(filePath, "same\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "track file"));

  await manager.replySession(sessionId, { text: "second prompt" });

  const notices = manager
    .listSessionMessages(sessionId)
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Note that the user manually modified these files:")
    );
  assert.equal(notices.length, 0);
});

test("replySession reports manual deletion of a tracked file", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-manual-delete-notice-workspace-");
  const home = createTempDir("deepcode-manual-delete-notice-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "deleted.txt");
  const manager = createSessionManager(workspace, "machine-id-manual-delete-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(filePath, "delete me\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "track file"));

  fs.unlinkSync(filePath);
  await manager.replySession(sessionId, { text: "check deletion" });

  const notice = manager
    .listSessionMessages(sessionId)
    .find(
      (message) =>
        message.role === "system" &&
        message.content === `Note that the user manually modified these files:\n${filePath}`
    );
  assert.ok(notice);
});

test("replySession ignores manually created untracked files", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-untracked-manual-file-workspace-");
  const home = createTempDir("deepcode-untracked-manual-file-home-");
  setHomeDir(home);

  const trackedPath = path.join(workspace, "tracked.txt");
  const untrackedPath = path.join(workspace, "untracked.txt");
  const manager = createSessionManager(workspace, "machine-id-untracked-manual-file");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(trackedPath, "tracked\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [trackedPath], "track file"));

  fs.writeFileSync(untrackedPath, "new manual file\n", "utf8");
  await manager.replySession(sessionId, { text: "second prompt" });

  const notices = manager
    .listSessionMessages(sessionId)
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Note that the user manually modified these files:")
    );
  assert.equal(notices.length, 0);
});

test("replySession does not insert manual-change notice for /continue", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-continue-no-manual-change-notice-workspace-");
  const home = createTempDir("deepcode-continue-no-manual-change-notice-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "tracked.txt");
  const manager = createSessionManager(workspace, "machine-id-continue-no-manual-change-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(filePath, "before\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "track file"));

  fs.writeFileSync(filePath, "manual change\n", "utf8");
  await manager.replySession(sessionId, { text: "/continue" });

  const notices = manager
    .listSessionMessages(sessionId)
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Note that the user manually modified these files:")
    );
  assert.equal(notices.length, 0);
});

test("replySession does not insert manual-change notice for permission-only replies", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-permission-no-manual-change-notice-workspace-");
  const home = createTempDir("deepcode-permission-no-manual-change-notice-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "tracked.txt");
  const manager = createSessionManager(workspace, "machine-id-permission-no-manual-change-notice");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  fs.writeFileSync(filePath, "before\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [filePath], "track file"));
  const assistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need permission",
    [
      {
        id: "call-read",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ file_path: filePath }) },
      },
    ],
    null
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, assistant);

  fs.writeFileSync(filePath, "manual change\n", "utf8");
  await manager.replySession(sessionId, { permissions: [{ toolCallId: "call-read", permission: "allow" }] });

  const notices = manager
    .listSessionMessages(sessionId)
    .filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Note that the user manually modified these files:")
    );
  assert.equal(notices.length, 0);
});

test("Write tool advances file-history while preserving the user prompt checkpoint", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-write-checkpoint-workspace-");
  const home = createTempDir("deepcode-write-checkpoint-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "index.html");
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-write-index",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ file_path: filePath, content: "<h1>Hello</h1>\n" }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "create an index page" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  assert.ok(userMessage?.checkpointHash);
  assert.equal(fs.existsSync(filePath), true);

  manager.restoreSessionCode(sessionId, userMessage.id);

  assert.equal(fs.existsSync(filePath), false);
});

test("Write checkpoints restore tool-touched files outside the workspace and leave unrelated files alone", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-write-outside-workspace-");
  const outsideDir = createTempDir("deepcode-write-outside-target-");
  const home = createTempDir("deepcode-write-outside-home-");
  setHomeDir(home);

  const outsideFilePath = path.join(outsideDir, "outside.txt");
  const unrelatedWorkspaceFilePath = path.join(workspace, "unrelated.txt");
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-write-outside",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ file_path: outsideFilePath, content: "outside\n" }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "create an outside file" });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  assert.ok(userMessage?.checkpointHash);
  assert.equal(fs.readFileSync(outsideFilePath, "utf8"), "outside\n");

  fs.writeFileSync(unrelatedWorkspaceFilePath, "keep\n", "utf8");
  manager.restoreSessionCode(sessionId, userMessage.id);

  assert.equal(fs.existsSync(outsideFilePath), false);
  assert.equal(fs.readFileSync(unrelatedWorkspaceFilePath, "utf8"), "keep\n");
});

test("missing git executable does not block sessions or Write tool calls", async () => {
  const workspace = createTempDir("deepcode-no-git-write-workspace-");
  const home = createTempDir("deepcode-no-git-write-home-");
  setHomeDir(home);

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const filePath = path.join(workspace, "index.html");
    const manager = createMockedClientSessionManager(workspace, [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-write-no-git",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ file_path: filePath, content: "<h1>No Git</h1>\n" }),
                  },
                },
              ],
            },
          },
        ],
      },
      createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);

    const sessionId = await manager.createSession({ text: "create an index page" });
    const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");

    assert.equal(fs.readFileSync(filePath, "utf8"), "<h1>No Git</h1>\n");
    assert.equal(userMessage?.checkpointHash, undefined);
    assert.equal(manager.getSession(sessionId)?.status, "completed");
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("restoreSessionConversation truncates messages before the selected user prompt", async () => {
  const workspace = createTempDir("deepcode-undo-conversation-workspace-");
  const home = createTempDir("deepcode-undo-conversation-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-undo-conversation");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const firstAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "first answer",
    null,
    null
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, firstAssistant);
  await manager.replySession(sessionId, { text: "second prompt" });
  const secondUserMessage = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "user")
    .at(-1);
  assert.ok(secondUserMessage);
  const secondAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "second answer",
    null,
    null
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, secondAssistant);

  manager.restoreSessionConversation(sessionId, secondUserMessage.id);

  const contents = manager.listSessionMessages(sessionId).map((message) => message.content);
  assert.ok(contents.includes("first prompt"));
  assert.ok(contents.includes("first answer"));
  assert.ok(!contents.includes("second prompt"));
  assert.ok(!contents.includes("second answer"));
  assert.equal(manager.getSession(sessionId)?.assistantReply, "first answer");
});

test("restoreSessionCode restores project files from the recorded Git checkpoint", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-undo-code-workspace-");
  const home = createTempDir("deepcode-undo-code-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-undo-code");
  const sessionId = "session-code-restore";
  const checkpointHash = createFileHistoryCommit(home, workspace, sessionId, { "tracked.txt": "before\n" });
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  assert.ok(fileHistory.recordCheckpoint(sessionId, [path.join(workspace, "new.txt")], "pre-create new.txt"));
  createFileHistoryCommit(home, workspace, sessionId, { "tracked.txt": "after\n", "new.txt": "remove me\n" });
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "after\n", "utf8");
  fs.writeFileSync(path.join(workspace, "new.txt"), "remove me\n", "utf8");

  (manager as any).appendSessionMessage(sessionId, {
    ...buildTestMessage("user-with-checkpoint", sessionId, "user", "restore here"),
    checkpointHash,
  });

  manager.restoreSessionCode(sessionId, "user-with-checkpoint");

  assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "before\n");
  assert.equal(fs.existsSync(path.join(workspace, "new.txt")), false);
});

test("restoreSessionCode preserves files that predate their first tracked mutation", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-undo-preexisting-files-workspace-");
  const home = createTempDir("deepcode-undo-preexisting-files-home-");
  setHomeDir(home);

  const readmePath = path.join(workspace, "README.md");
  const readmeEnPath = path.join(workspace, "README-en.md");
  const readmeZhPath = path.join(workspace, "README-zh_CN.md");
  fs.writeFileSync(readmePath, "这是一个hello world演示项目\n", "utf8");
  fs.writeFileSync(readmeEnPath, "This is a hello world demo project.\n", "utf8");
  fs.writeFileSync(readmeZhPath, "", "utf8");

  const manager = createSessionManager(workspace, "machine-id-undo-preexisting-files");
  const sessionId = "session-undo-preexisting-files";
  const gitDir = getFileHistoryGitDir(home, workspace);
  const fileHistory = new GitFileHistory(workspace, gitDir);
  fileHistory.ensureSession(sessionId);

  const targetCheckpoint = fileHistory.recordCheckpoint(
    sessionId,
    [readmePath, readmeEnPath],
    "checkpoint before syncing all readmes"
  );
  assert.ok(targetCheckpoint);

  assert.ok(fileHistory.recordCheckpoint(sessionId, [readmeZhPath], "pre-sync zh readme"));
  fs.writeFileSync(readmePath, "Synced readme\n", "utf8");
  fs.writeFileSync(readmeEnPath, "Synced readme\n", "utf8");
  fs.writeFileSync(readmeZhPath, "Synced readme\n", "utf8");
  assert.ok(fileHistory.recordCheckpoint(sessionId, [readmePath, readmeEnPath, readmeZhPath], "synced readmes"));

  (manager as any).appendSessionMessage(sessionId, {
    ...buildTestMessage("user-with-readme-checkpoint", sessionId, "user", "sync README*.md"),
    checkpointHash: targetCheckpoint,
  });

  manager.restoreSessionCode(sessionId, "user-with-readme-checkpoint");

  assert.equal(fs.readFileSync(readmePath, "utf8"), "这是一个hello world演示项目\n");
  assert.equal(fs.readFileSync(readmeEnPath, "utf8"), "This is a hello world demo project.\n");
  assert.equal(fs.readFileSync(readmeZhPath, "utf8"), "");
});

test("restoreSessionCode restores deleted tracked files and leaves unrelated files alone", async (t) => {
  if (!hasGit()) {
    t.skip("git is not available");
    return;
  }

  const workspace = createTempDir("deepcode-undo-deleted-files-workspace-");
  const home = createTempDir("deepcode-undo-deleted-files-home-");
  setHomeDir(home);

  const trackedPath = path.join(workspace, "tracked.txt");
  const unrelatedPath = path.join(workspace, "unrelated.txt");
  fs.writeFileSync(trackedPath, "before delete\n", "utf8");
  fs.writeFileSync(unrelatedPath, "do not touch\n", "utf8");

  const manager = createSessionManager(workspace, "machine-id-undo-deleted-files");
  const sessionId = "session-undo-deleted-files";
  const gitDir = getFileHistoryGitDir(home, workspace);
  const fileHistory = new GitFileHistory(workspace, gitDir);
  fileHistory.ensureSession(sessionId);
  const targetCheckpoint = fileHistory.recordCheckpoint(sessionId, [trackedPath], "before delete");
  assert.ok(targetCheckpoint);

  fs.unlinkSync(trackedPath);
  assert.ok(fileHistory.recordCheckpoint(sessionId, [trackedPath], "after delete"));

  (manager as any).appendSessionMessage(sessionId, {
    ...buildTestMessage("user-before-delete", sessionId, "user", "restore deleted file"),
    checkpointHash: targetCheckpoint,
  });

  manager.restoreSessionCode(sessionId, "user-before-delete");

  assert.equal(fs.readFileSync(trackedPath, "utf8"), "before delete\n");
  assert.equal(fs.readFileSync(unrelatedPath, "utf8"), "do not touch\n");
});

test("replySession /continue runs trailing pending tool calls before requesting another response", async () => {
  const workspace = createTempDir("deepcode-continue-tool-workspace-");
  const home = createTempDir("deepcode-continue-tool-home-");
  setHomeDir(home);

  const responses = [
    createChatResponse("continued after tool", {
      prompt_tokens: 9,
      completion_tokens: 2,
      total_tokens: 11,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const pendingAssistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need to read a file",
    [
      {
        id: "call-pending-read",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ file_path: path.join(workspace, "note.txt") }) },
      },
    ],
    null
  ) as SessionMessage;
  fs.writeFileSync(path.join(workspace, "note.txt"), "hello from pending tool\n", "utf8");
  (manager as any).appendSessionMessage(sessionId, pendingAssistant);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, { text: "/continue" });

  const messages = manager.listSessionMessages(sessionId);
  const toolMessage = messages.find((message) => {
    const params = message.messageParams as { tool_call_id?: string } | null;
    return message.role === "tool" && params?.tool_call_id === "call-pending-read";
  });
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const userMessages = messages.filter((message) => message.role === "user");

  assert.ok(toolMessage);
  assert.match(toolMessage.content ?? "", /hello from pending tool/);
  assert.equal(assistantMessages[assistantMessages.length - 1]?.content, "continued after tool");
  assert.equal(
    userMessages.some((message) => message.content === "/continue"),
    false
  );
});

test("replySession rebuilds snippet state from persisted read history before editing", async () => {
  const workspace = createTempDir("deepcode-rebuild-snippet-workspace-");
  const home = createTempDir("deepcode-rebuild-snippet-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "note.txt");
  fs.writeFileSync(filePath, "alpha\nbeta\n", "utf8");

  const responses = [
    createToolCallResponse(
      [
        {
          id: "call-edit",
          type: "function",
          function: {
            name: "edit",
            arguments: JSON.stringify({
              snippet_id: "full_file_5",
              file_path: filePath,
              old_string: "beta",
              new_string: "gamma",
            }),
          },
        },
      ],
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    ),
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const readToolMessage = (manager as any).buildToolMessage(
    sessionId,
    "call-read",
    JSON.stringify({
      ok: true,
      name: "read",
      output: "     1\talpha\n     2\tbeta\n",
      metadata: {
        snippet: {
          id: "full_file_5",
          filePath,
          startLine: 1,
          endLine: 3,
        },
      },
    }),
    { name: "read", arguments: JSON.stringify({ file_path: filePath }) }
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, readToolMessage);

  clearSessionState(sessionId);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, { text: "change beta" });

  assert.equal(fs.readFileSync(filePath, "utf8"), "alpha\ngamma\n");
  const editToolMessage = manager.listSessionMessages(sessionId).find((message) => {
    const params = message.messageParams as { tool_call_id?: string } | null;
    return message.role === "tool" && params?.tool_call_id === "call-edit";
  });
  assert.ok(editToolMessage);
  assert.match(editToolMessage.content ?? "", /"ok":true|"ok": true/);
  assert.doesNotMatch(editToolMessage.content ?? "", /Unknown snippet_id/);
});

test("activateSession pauses for permission when a tool call requires ask", async () => {
  const workspace = createTempDir("deepcode-permission-ask-workspace-");
  const home = createTempDir("deepcode-permission-ask-home-");
  setHomeDir(home);

  const manager = createPermissionSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-bash",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "rg TODO src",
                      description: "Search TODO markers",
                      sideEffects: ["read-in-cwd"],
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ],
    {
      allow: [],
      deny: [],
      ask: [],
      defaultMode: "askAll",
    }
  );

  const sessionId = await manager.createSession({ text: "search todos" });
  const session = manager.getSession(sessionId);
  const assistant = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);

  assert.equal(session?.status, "ask_permission");
  assert.equal(session?.askPermissions?.[0]?.toolCallId, "call-bash");
  assert.deepEqual(session?.askPermissions?.[0]?.scopes, ["read-in-cwd"]);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-bash", permission: "ask" }]);
  assert.equal(
    manager.listSessionMessages(sessionId).some((message) => message.role === "tool"),
    false
  );
});

test("activateSession temporarily asks before allowed writes in Plan Mode", async () => {
  const workspace = createTempDir("deepcode-plan-permission-workspace-");
  const home = createTempDir("deepcode-plan-permission-home-");
  setHomeDir(home);

  const manager = createPermissionSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ file_path: path.join(workspace, "plan.txt"), content: "planned" }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ],
    {
      allow: ["write-in-cwd"],
      deny: [],
      ask: [],
      defaultMode: "allowAll",
    }
  );

  const sessionId = await manager.createSession({ text: "Plan this change", planMode: true });
  const session = manager.getSession(sessionId);
  const assistant = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);

  assert.equal(session?.status, "ask_permission");
  assert.deepEqual(session?.askPermissions?.[0]?.scopes, ["write-in-cwd"]);
  assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-write", permission: "ask" }]);
});

test(
  "activateSession does not force allowed temporary writes to ask in Plan Mode",
  { skip: process.platform === "win32" },
  async () => {
    const workspace = createTempDir("deepcode-plan-tmp-permission-workspace-");
    const home = createTempDir("deepcode-plan-tmp-permission-home-");
    const targetPath = path.join("/tmp", `deepcode-plan-${crypto.randomUUID()}.txt`);
    tempDirs.push(targetPath);
    setHomeDir(home);

    const manager = createPermissionSessionManager(
      workspace,
      [
        {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-write-tmp",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ file_path: targetPath, content: "planned" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
        createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      ],
      {
        allow: ["write-in-tmp"],
        deny: [],
        ask: [],
        defaultMode: "allowAll",
      }
    );

    const sessionId = await manager.createSession({ text: "Plan this change", planMode: true });
    const session = manager.getSession(sessionId);
    const assistant = manager
      .listSessionMessages(sessionId)
      .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);

    assert.equal(session?.status, "completed");
    assert.deepEqual(assistant?.meta?.permissions, [{ toolCallId: "call-write-tmp", permission: "allow" }]);
    assert.equal(fs.readFileSync(targetPath, "utf8"), "planned");
  }
);

test("SessionManager preserves permission_denied status when sessions are reloaded", async () => {
  const workspace = createTempDir("deepcode-permission-denied-workspace-");
  const home = createTempDir("deepcode-permission-denied-home-");
  setHomeDir(home);

  const permissions = {
    allow: [],
    deny: [],
    ask: [],
    defaultMode: "askAll" as const,
  };
  const manager = createPermissionSessionManager(
    workspace,
    [
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-bash",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "rg TODO src",
                      description: "Search TODO markers",
                      sideEffects: ["read-in-cwd"],
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
    permissions
  );

  const sessionId = await manager.createSession({ text: "search todos" });
  manager.denySessionPermission(sessionId);

  const reloadedManager = createPermissionSessionManager(workspace, [], permissions);
  const reloadedSession = reloadedManager.getSession(sessionId);

  assert.equal(reloadedSession?.status, "permission_denied");
  assert.equal(reloadedSession?.failReason, "Permission denied by user");
});

test("replySession applies permission replies, runs pending tools, and stores always allow scopes", async () => {
  const workspace = createTempDir("deepcode-permission-allow-workspace-");
  const home = createTempDir("deepcode-permission-allow-home-");
  setHomeDir(home);
  fs.writeFileSync(path.join(workspace, "note.txt"), "allowed content\n", "utf8");

  const manager = createPermissionSessionManager(
    workspace,
    [createChatResponse("continued", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })],
    {
      allow: [],
      deny: [],
      ask: ["read-in-cwd"],
      defaultMode: "allowAll",
    }
  );
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};
  const sessionId = await manager.createSession({ text: "first prompt" });
  const assistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need to read",
    [
      {
        id: "call-read",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ file_path: path.join(workspace, "note.txt") }) },
      },
    ],
    null
  ) as SessionMessage;
  assistant.meta = { ...(assistant.meta ?? {}), permissions: [{ toolCallId: "call-read", permission: "ask" }] };
  (manager as any).appendSessionMessage(sessionId, assistant);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, {
    text: "/continue",
    permissions: [{ toolCallId: "call-read", permission: "allow" }],
    alwaysAllows: ["read-in-cwd"],
  });

  const toolMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "tool");
  const settings = JSON.parse(fs.readFileSync(path.join(workspace, ".deepcode", "settings.json"), "utf8"));

  assert.match(toolMessage?.content ?? "", /allowed content/);
  assert.deepEqual(settings.permissions.allow, ["read-in-cwd"]);
  assert.equal(manager.getSession(sessionId)?.status, "completed");
});

test("replySession turns denied permission replies into tool errors before appending user text", async () => {
  const workspace = createTempDir("deepcode-permission-deny-workspace-");
  const home = createTempDir("deepcode-permission-deny-home-");
  setHomeDir(home);

  const manager = createPermissionSessionManager(
    workspace,
    [createChatResponse("handled denial", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })],
    {
      allow: [],
      deny: [],
      ask: ["write-out-cwd"],
      defaultMode: "allowAll",
    }
  );
  const originalActivateSession = manager.activateSession.bind(manager);
  (manager as any).activateSession = async () => {};
  const sessionId = await manager.createSession({ text: "first prompt" });
  const assistant = (manager as any).buildAssistantMessage(
    sessionId,
    "Need to write",
    [
      {
        id: "call-write",
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ file_path: "/tmp/outside.txt", content: "x" }) },
      },
    ],
    null
  ) as SessionMessage;
  assistant.meta = { ...(assistant.meta ?? {}), permissions: [{ toolCallId: "call-write", permission: "ask" }] };
  (manager as any).appendSessionMessage(sessionId, assistant);
  (manager as any).activateSession = originalActivateSession;

  await manager.replySession(sessionId, {
    text: "Do not write outside the workspace.",
    permissions: [{ toolCallId: "call-write", permission: "deny" }],
  });

  const messages = manager.listSessionMessages(sessionId);
  const assistantIndex = messages.findIndex((message) => message.id === assistant.id);
  const toolMessage = messages[assistantIndex + 1];
  const userMessage = messages[assistantIndex + 2];

  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /User denied the required permission/);
  assert.equal(userMessage?.role, "user");
  assert.equal(userMessage?.content, "Do not write outside the workspace.");
});

test("replySession preserves raw session messages when a previous tool call is pending", async () => {
  const workspace = createTempDir("deepcode-pending-tool-workspace-");
  const home = createTempDir("deepcode-pending-tool-home-");
  setHomeDir(home);

  globalThis.fetch = (async () =>
    ({
      ok: true,
      text: async () => "",
    }) as Response) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-pending-tool");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const assistantMessage = (manager as any).buildAssistantMessage(
    sessionId,
    "I will run a tool.",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"sleep 100"}' },
      },
    ],
    ""
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, assistantMessage);

  await manager.replySession(sessionId, { text: "second prompt" });

  const messages = manager.listSessionMessages(sessionId);
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessage.id);
  assert.notEqual(assistantIndex, -1);
  assert.equal(messages[assistantIndex + 1]?.role, "user");
  assert.equal(messages[assistantIndex + 1]?.content, "second prompt");
  assert.equal(
    messages.some((message) => String(message.content).includes("Previous tool call did not complete.")),
    false
  );
});

test("buildOpenAIMessages inserts interrupted results for missing tool messages", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-missing-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "I will run a tool.",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"sleep 100"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const userMessage = buildTestMessage("user-after-tool-call", "session-1", "user", "continue");

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, userMessage],
    false,
    "test-model"
  ) as Array<{
    role: string;
    content: string;
    tool_call_id?: string;
  }>;

  assert.equal(openAIMessages.length, 3);
  assert.equal(openAIMessages[0]?.role, "assistant");
  assert.equal(openAIMessages[1]?.role, "tool");
  assert.equal(openAIMessages[1]?.tool_call_id, "call-1");
  assert.match(openAIMessages[1]?.content ?? "", /Previous tool call did not complete/);
  assert.equal(openAIMessages[2]?.role, "user");
});

test("buildOpenAIMessages keeps only the first non-interrupted tool result for a tool call", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-duplicate-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"date"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const successToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "bash", output: "2026-05-07 星期四\n" }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;
  const interruptedToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({
      ok: false,
      name: "bash",
      error: "Previous tool call did not complete.",
      metadata: { interrupted: true },
    }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, successToolMessage, interruptedToolMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string; tool_call_id?: string }>;
  const toolMessages = openAIMessages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.tool_call_id, "call-1");
  assert.match(toolMessages[0]?.content ?? "", /2026-05-07/);
  assert.doesNotMatch(toolMessages[0]?.content ?? "", /Previous tool call did not complete/);
});

test("buildOpenAIMessages prefers a later real tool result over an earlier interrupted placeholder", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-prefer-real-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"date"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const interruptedToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({
      ok: false,
      name: "bash",
      error: "Previous tool call did not complete.",
      metadata: { interrupted: true },
    }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;
  const successToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "bash", output: "real result" }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, interruptedToolMessage, successToolMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string; tool_call_id?: string }>;
  const toolMessages = openAIMessages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.tool_call_id, "call-1");
  assert.match(toolMessages[0]?.content ?? "", /real result/);
});

test("buildOpenAIMessages ignores orphan tool messages", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-orphan-tool");
  const userMessage = buildTestMessage("user-1", "session-1", "user", "hello");
  const orphanToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-orphan",
    JSON.stringify({ ok: true, name: "bash", output: "orphan" }),
    { name: "bash", arguments: '{"command":"echo orphan"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [userMessage, orphanToolMessage],
    false,
    "test-model"
  ) as Array<{
    role: string;
  }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["user"]
  );
});

test("buildOpenAIMessages moves a later paired tool message behind its assistant", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-later-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"date"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const userMessage = buildTestMessage("user-between", "session-1", "user", "continue");
  const toolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "bash", output: "paired later" }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, userMessage, toolMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool", "user"]
  );
  assert.match(openAIMessages[1]?.content ?? "", /paired later/);
});

test("buildOpenAIMessages preserves a complete multi-tool happy path", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-multi-tool-happy");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: '{"file_path":"/tmp/a.txt"}' },
      },
      {
        id: "call-2",
        type: "function",
        function: { name: "bash", arguments: '{"command":"pwd"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const firstToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "read", content: "file content" }),
    { name: "read", arguments: '{"file_path":"/tmp/a.txt"}' }
  ) as SessionMessage;
  const secondToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-2",
    JSON.stringify({ ok: true, name: "bash", output: "/tmp\n" }),
    { name: "bash", arguments: '{"command":"pwd"}' }
  ) as SessionMessage;
  const userMessage = buildTestMessage("user-after-complete-tools", "session-1", "user", "thanks");

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, firstToolMessage, secondToolMessage, userMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string; tool_call_id?: string }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool", "tool", "user"]
  );
  assert.deepEqual(
    openAIMessages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ["call-1", "call-2"]
  );
  assert.equal(
    openAIMessages.some((message) => message.content.includes("Previous tool call did not complete.")),
    false
  );
});

test("buildOpenAIMessages preserves a real failed tool result", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-real-failed-tool");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"false"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const failedToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: false, name: "bash", error: "Command failed", metadata: { exitCode: 1 } }),
    { name: "bash", arguments: '{"command":"false"}' }
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, failedToolMessage],
    false,
    "test-model"
  ) as Array<{
    role: string;
    content: string;
    tool_call_id?: string;
  }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool"]
  );
  assert.equal(openAIMessages[1]?.tool_call_id, "call-1");
  assert.match(openAIMessages[1]?.content ?? "", /Command failed/);
  assert.doesNotMatch(openAIMessages[1]?.content ?? "", /Previous tool call did not complete/);
});

test("UpdatePlan tool params only show explanation when provided", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-update-plan-params");
  const plan = "## Task List\n\n- [ ] Inspect project";

  const withExplanation = (manager as any).buildToolMessage(
    "session-1",
    "call-plan-1",
    JSON.stringify({ ok: true, name: "UpdatePlan", output: "Plan updated." }),
    { name: "UpdatePlan", arguments: JSON.stringify({ plan, explanation: "Start planning" }) }
  ) as SessionMessage;
  const withoutExplanation = (manager as any).buildToolMessage(
    "session-1",
    "call-plan-2",
    JSON.stringify({ ok: true, name: "UpdatePlan", output: "Plan updated." }),
    { name: "UpdatePlan", arguments: JSON.stringify({ plan }) }
  ) as SessionMessage;

  assert.equal(withExplanation.meta?.paramsMd, "Start planning");
  assert.equal(withoutExplanation.meta?.paramsMd, "");
});

test("Write tool params prefer file_path even when content appears first", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-write-params");
  const filePath = path.join(process.cwd(), "index.html");

  const toolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-write-1",
    JSON.stringify({ ok: true, name: "write", output: "Created file." }),
    {
      name: "write",
      arguments: JSON.stringify({
        content: "// === entry ===\nconsole.log('demo');\n",
        file_path: filePath,
      }),
    }
  ) as SessionMessage;

  assert.equal(toolMessage.meta?.paramsMd, filePath);
});

test("UnderstandImage tool params show image_path instead of prompt", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-understand-image-params");
  const imagePath = path.join(process.cwd(), "screenshot.png");

  const toolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-understand-image-1",
    JSON.stringify({ ok: true, name: "UnderstandImage", output: "A screenshot." }),
    {
      name: "UnderstandImage",
      arguments: JSON.stringify({ prompt: "Describe this image", image_path: imagePath }),
    }
  ) as SessionMessage;

  assert.equal(toolMessage.meta?.paramsMd, imagePath);
});

test("ReadImage tool params show a workspace-relative file path", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-read-image-params");
  const imagePath = path.join(process.cwd(), "images", "screenshot.png");

  const toolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-read-image-1",
    JSON.stringify({ ok: true, name: "ReadImage", output: "Image loaded." }),
    {
      name: "ReadImage",
      arguments: JSON.stringify({ file_path: imagePath }),
    }
  ) as SessionMessage;

  assert.equal(toolMessage.meta?.paramsMd, path.join("images", "screenshot.png"));
});

test("SessionManager rejects prose-only intent, retries, and allows the same prose with a tool call", async () => {
  const workspace = createTempDir("deepcode-intent-guard-workspace-");
  const home = createTempDir("deepcode-intent-guard-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "note.txt");
  fs.writeFileSync(filePath, "guarded\n", "utf8");
  const responses = [
    createChatResponse("Let me run it now.", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    {
      choices: [
        {
          message: {
            content: "Let me run it now.",
            tool_calls: [
              {
                id: "call-read-after-rejection",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ file_path: filePath }) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    createChatResponse("Done.", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ];
  const events: Array<{ stepId: string; hardStopped: boolean }> = [];
  let chatCalls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          chatCalls += 1;
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      intentNarrationGuard: {
        enabled: true,
        phrases: ["let me run"],
        instruction: "No prose intent. Emit the tool call now.",
        hardStopRejections: 4,
        hardStopWindow: 6,
      },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onIntentNarrationRejected: (event) => events.push(event),
  });

  const sessionId = await manager.createSession({ text: "" });
  const messages = manager.listSessionMessages(sessionId);
  const matchingAssistantMessages = messages.filter(
    (message) => message.role === "assistant" && message.content === "Let me run it now."
  );
  const correction = messages.find(
    (message) => message.role === "system" && message.content === "No prose intent. Emit the tool call now."
  );
  const toolMessage = messages.find(
    (message) =>
      message.role === "tool" &&
      (message.messageParams as { tool_call_id?: string } | null)?.tool_call_id === "call-read-after-rejection"
  );

  assert.equal(chatCalls, 3);
  assert.equal(matchingAssistantMessages.length, 1, "the rejected prose turn must not be persisted");
  assert.equal(correction?.visible, true);
  assert.match(toolMessage?.content ?? "", /guarded/);
  assert.equal(manager.getSession(sessionId)?.intentNarrationRejections, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.stepId, `${sessionId}:1`);
  assert.equal(events[0]?.hardStopped, false);
  assert.equal(manager.getSession(sessionId)?.status, "completed");

  const logLines = fs
    .readFileSync(path.join(home, ".deepcode", "logs", "intent-narration.log"), "utf8")
    .trim()
    .split("\n");
  const logEntry = JSON.parse(logLines[0] ?? "{}") as Record<string, unknown>;
  assert.match(String(logEntry.textHash), /^sha256:[0-9a-f]{64}$/);
  assert.equal(logEntry.textPreview, "Let me run it now.");
  assert.equal(logEntry.stepId, `${sessionId}:1`);
});

test("SessionManager hard-stops repeated intent narration at four of the last six turns", async () => {
  const workspace = createTempDir("deepcode-intent-cap-workspace-");
  const home = createTempDir("deepcode-intent-cap-home-");
  setHomeDir(home);

  const responses = Array.from({ length: 4 }, () =>
    createChatResponse("Let me run the check now.", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
  );
  const manager = createMockedClientSessionManager(workspace, responses);
  const sessionId = await manager.createSession({ text: "" });
  const session = manager.getSession(sessionId);

  assert.equal(responses.length, 0);
  assert.equal(session?.status, "failed");
  assert.equal(session?.intentNarrationRejections, 4);
  assert.match(session?.failReason ?? "", /4 rejected turns within the last 6 model turns/);
  assert.equal(
    manager
      .listSessionMessages(sessionId)
      .filter((message) => message.content === "No prose intent. Emit the tool call now.").length,
    4
  );
});

test("LLM tool calls without ids are limited to one action per step", async () => {
  const workspace = createTempDir("deepcode-tool-call-id-workspace-");
  const home = createTempDir("deepcode-tool-call-id-home-");
  setHomeDir(home);

  const filePath = path.join(workspace, "note.txt");
  fs.writeFileSync(filePath, "hello\n", "utf8");
  const plan = "## Task List\n\n- [ ] Inspect current behavior";
  const manager = createMockedClientSessionManager(workspace, [
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "",
                type: "function",
                function: {
                  name: "UpdatePlan",
                  arguments: JSON.stringify({ plan, explanation: "Initial plan" }),
                },
              },
              {
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ file_path: filePath }),
                },
              },
            ],
          },
        },
      ],
    },
    createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);

  const sessionId = await manager.createSession({ text: "inspect note" });
  const assistantMessage = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant" && (message.messageParams as any)?.tool_calls);
  const toolCalls = (assistantMessage?.messageParams as { tool_calls?: Array<{ id?: unknown }> } | null)?.tool_calls;

  assert.equal(toolCalls?.length, 1);
  assert.match(String(toolCalls?.[0]?.id), /^[0-9a-f]{32}$/);

  const toolMessages = manager.listSessionMessages(sessionId).filter((message) => message.role === "tool");
  assert.deepEqual(
    toolMessages.map((message) => (message.messageParams as { tool_call_id?: unknown } | null)?.tool_call_id),
    toolCalls?.map((toolCall) => toolCall.id)
  );

  assert.equal(toolMessages.length, 1);
  assert.equal((toolMessages[0]?.meta?.function as { name?: string } | undefined)?.name, "UpdatePlan");
});

test("buildOpenAIMessages repairs mixed missing duplicate and orphan tool messages", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-mixed-tool-badcase");
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: '{"file_path":"/tmp/missing.txt"}' },
      },
      {
        id: "call-2",
        type: "function",
        function: { name: "bash", arguments: '{"command":"pwd"}' },
      },
    ],
    ""
  ) as SessionMessage;
  const orphanToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-orphan",
    JSON.stringify({ ok: true, name: "bash", output: "orphan" }),
    { name: "bash", arguments: '{"command":"echo orphan"}' }
  ) as SessionMessage;
  const pairedToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-2",
    JSON.stringify({ ok: true, name: "bash", output: "/tmp\n" }),
    { name: "bash", arguments: '{"command":"pwd"}' }
  ) as SessionMessage;
  const duplicateToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-2",
    JSON.stringify({ ok: true, name: "bash", output: "duplicate" }),
    { name: "bash", arguments: '{"command":"pwd"}' }
  ) as SessionMessage;
  const userMessage = buildTestMessage("user-after-mixed-tools", "session-1", "user", "continue");

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [assistantMessage, orphanToolMessage, pairedToolMessage, duplicateToolMessage, userMessage],
    false,
    "test-model"
  ) as Array<{ role: string; content: string; tool_call_id?: string }>;
  const toolMessages = openAIMessages.filter((message) => message.role === "tool");

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool", "tool", "user"]
  );
  assert.deepEqual(
    toolMessages.map((message) => message.tool_call_id),
    ["call-1", "call-2"]
  );
  assert.match(toolMessages[0]?.content ?? "", /Previous tool call did not complete/);
  assert.match(toolMessages[1]?.content ?? "", /\/tmp/);
  assert.equal(
    openAIMessages.some((message) => message.content.includes("orphan")),
    false
  );
  assert.equal(
    openAIMessages.some((message) => message.content.includes("duplicate")),
    false
  );
});

test("buildOpenAIMessages ignores tool messages that appear before their assistant", () => {
  const manager = createSessionManager(process.cwd(), "machine-id-tool-before-assistant");
  const earlyToolMessage = (manager as any).buildToolMessage(
    "session-1",
    "call-1",
    JSON.stringify({ ok: true, name: "bash", output: "too early" }),
    { name: "bash", arguments: '{"command":"date"}' }
  ) as SessionMessage;
  const assistantMessage = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"date"}' },
      },
    ],
    ""
  ) as SessionMessage;

  const openAIMessages = (manager as any).buildOpenAIMessages(
    [earlyToolMessage, assistantMessage],
    false,
    "test-model"
  ) as Array<{
    role: string;
    content: string;
    tool_call_id?: string;
  }>;

  assert.deepEqual(
    openAIMessages.map((message) => message.role),
    ["assistant", "tool"]
  );
  assert.equal(openAIMessages[1]?.tool_call_id, "call-1");
  assert.match(openAIMessages[1]?.content ?? "", /Previous tool call did not complete/);
  assert.doesNotMatch(openAIMessages[1]?.content ?? "", /too early/);
});

test("SessionManager accumulates response usage while active tokens track the latest response", async () => {
  const workspace = createTempDir("deepcode-usage-workspace-");
  const home = createTempDir("deepcode-usage-home-");
  setHomeDir(home);

  const responses = [
    createChatResponse("first", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 3,
    }),
    createChatResponse("second", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_tokens_details: { cached_tokens: 11 },
      completion_tokens_details: { reasoning_tokens: 4 },
      prompt_cache_hit_tokens: 11,
      prompt_cache_miss_tokens: 9,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  const usagePerModel = session?.usagePerModel?.["test-model"] as Record<string, any>;
  assert.equal(session?.activeTokens, 27);
  assert.equal(usage.prompt_tokens, 30);
  assert.equal(usage.completion_tokens, 12);
  assert.equal(usage.total_tokens, 42);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usage.prompt_cache_hit_tokens, 18);
  assert.equal(usage.prompt_cache_miss_tokens, 12);
  assert.equal(usagePerModel.prompt_tokens, 30);
  assert.equal(usagePerModel.completion_tokens, 12);
  assert.equal(usagePerModel.total_tokens, 42);
  assert.equal(usagePerModel.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usagePerModel.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usagePerModel.prompt_cache_hit_tokens, 18);
  assert.equal(usagePerModel.prompt_cache_miss_tokens, 12);
  assert.equal(usagePerModel.total_reqs, 2);
});

test("SessionManager stores usage per model across model changes", async () => {
  const workspace = createTempDir("deepcode-usage-per-model-workspace-");
  const home = createTempDir("deepcode-usage-per-model-home-");
  setHomeDir(home);

  let currentModel = "deepseek-v4-pro";
  const responses = [
    createChatResponse("pro response", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    }),
    createChatResponse("flash response", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_cache_hit_tokens: 6,
    }),
  ];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: currentModel,
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: currentModel }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const sessionId = await manager.createSession({ text: "" });
  currentModel = "deepseek-v4-flash";
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  assert.deepEqual(Object.keys(session?.usagePerModel ?? {}).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.prompt_tokens, 10);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.completion_tokens, 5);
  assert.equal(session?.usagePerModel?.["deepseek-v4-pro"]?.total_reqs, 1);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.prompt_tokens, 20);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.completion_tokens, 7);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.prompt_cache_hit_tokens, 6);
  assert.equal(session?.usagePerModel?.["deepseek-v4-flash"]?.total_reqs, 1);
  assert.equal(session?.usage?.prompt_tokens, 30);
  assert.equal(session?.usage?.completion_tokens, 12);
  assert.equal(session?.usage?.total_tokens, 42);
});

test("SessionManager resets active tokens to latest post-compaction response usage", async () => {
  const workspace = createTempDir("deepcode-compact-usage-workspace-");
  const home = createTempDir("deepcode-compact-usage-home-");
  setHomeDir(home);

  const responses = [
    createChatResponse("large", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000,
    }),
    createChatResponse("summary", {
      prompt_tokens: 100,
      completion_tokens: 23,
      total_tokens: 123,
    }),
    createChatResponse("after compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  assert.equal(manager.getSession(sessionId)?.activeTokens, 140_000);

  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  const usagePerModel = session?.usagePerModel?.["test-model"] as Record<string, any>;
  assert.equal(session?.activeTokens, 7);
  assert.equal(usage.prompt_tokens, 140_095);
  assert.equal(usage.completion_tokens, 35);
  assert.equal(usage.total_tokens, 140_130);
  assert.equal(usagePerModel.prompt_tokens, 140_095);
  assert.equal(usagePerModel.completion_tokens, 35);
  assert.equal(usagePerModel.total_tokens, 140_130);
  assert.equal(usagePerModel.total_reqs, 3);
});

test("SessionManager uses the configured auto compact window", async () => {
  const workspace = createTempDir("deepcode-custom-compact-window-workspace-");
  const home = createTempDir("deepcode-custom-compact-window-home-");
  setHomeDir(home);

  const responses = [
    createChatResponse("large", { prompt_tokens: 990, completion_tokens: 10, total_tokens: 1000 }),
    createChatResponse("summary", { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }),
    createChatResponse("after compact", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
  ];
  const manager = createMockedClientSessionManager(workspace, responses, 500);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  assert.equal(manager.getSession(sessionId)?.activeTokens, 7);
  assert.equal(manager.getSession(sessionId)?.usagePerModel?.["test-model"]?.total_reqs, 3);
});

test("SessionManager streams chat completions and counts reasoning progress", async () => {
  const workspace = createTempDir("deepcode-stream-workspace-");
  const home = createTempDir("deepcode-stream-home-");
  setHomeDir(home);

  const progressEvents: Array<{
    phase: string;
    estimatedTokens: number;
    formattedTokens: string;
  }> = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>, options?: Record<string, unknown>) => {
          assert.equal(request.stream, true);
          assert.deepEqual(request.stream_options, { include_usage: true });
          assert.equal(request.temperature, 0.25);
          assert.equal(options?.maxRetries, 0);
          return createChatStreamResponse([
            { choices: [{ delta: { reasoning_content: "思考" } }] },
            { choices: [{ delta: { content: "hello" } }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
              },
            },
          ]);
        },
      },
    },
  };

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      temperature: 0.25,
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmStreamProgress: (progress) => {
      progressEvents.push({
        phase: progress.phase,
        estimatedTokens: progress.estimatedTokens,
        formattedTokens: progress.formattedTokens,
      });
    },
  });

  const sessionId = await manager.createSession({ text: "" });
  const assistantMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "assistant");

  assert.equal(assistantMessage?.content, "hello");
  assert.equal((assistantMessage?.messageParams as any)?.reasoning_content, "思考");
  assert.equal(manager.getSession(sessionId)?.activeTokens, 5);
  assert.deepEqual(
    progressEvents.map((event) => event.phase),
    ["start", "update", "update", "end"]
  );
  assert.equal(progressEvents[1]?.estimatedTokens, 1);
  assert.equal(progressEvents[2]?.formattedTokens, "3");
});

test("SessionManager retries a disconnected stream and discards the partial response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  let calls = 0;
  let notifyRetry!: () => void;
  const retryNotified = new Promise<void>((resolve) => {
    notifyRetry = resolve;
  });
  const retryEvents: Array<{ attempt: number; error: string }> = [];
  const assistantMessages: SessionMessage[] = [];
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          if (calls === 1) {
            return (async function* () {
              yield { choices: [{ delta: { content: "partial" } }] };
              throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
            })();
          }
          return createChatStreamResponse([
            { choices: [{ delta: { content: "complete" }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          ]);
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: client as any, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: (message) => assistantMessages.push(message),
    onLlmRetry: (event) => {
      retryEvents.push({ attempt: event.attempt, error: event.error });
      notifyRetry();
    },
  });

  const responsePromise = (manager as any).createChatCompletionStream(
    client,
    { model: "test-model" },
    undefined,
    "retry-session"
  );
  await retryNotified;
  t.mock.timers.tick(800);
  const response = await responsePromise;

  assert.equal(calls, 2);
  assert.deepEqual(retryEvents, [{ attempt: 1, error: "read ECONNRESET" }]);
  assert.equal(assistantMessages[0]?.content, "Request failed: read ECONNRESET");
  assert.equal(assistantMessages[0]?.sessionId, "retry-session");
  assert.equal(response.choices[0].message.content, "complete");
});

test("SessionManager stops after five retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  let calls = 0;
  let notifyRetry!: () => void;
  let retryNotified = new Promise<void>((resolve) => {
    notifyRetry = resolve;
  });
  const retryEvents: Array<{ attempt: number; delayMs: number }> = [];
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          throw Object.assign(new Error("Bad Gateway"), { status: 502 });
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: client as any, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmRetry: (event) => {
      retryEvents.push({ attempt: event.attempt, delayMs: event.delayMs });
      notifyRetry();
    },
  });

  const responsePromise = (manager as any).createChatCompletionStream(client, { model: "test-model" });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await retryNotified;
    const event = retryEvents.at(-1)!;
    assert.equal(event.attempt, attempt);
    retryNotified = new Promise<void>((resolve) => {
      notifyRetry = resolve;
    });
    t.mock.timers.tick(event.delayMs);
  }

  await assert.rejects(responsePromise, (error: Error & { status?: number }) => error.status === 502);
  assert.equal(calls, 6);
  assert.deepEqual(
    retryEvents.map((event) => event.attempt),
    [1, 2, 3, 4, 5]
  );
});

test("SessionManager honors Retry-After when scheduling a retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let retryDelayMs = 0;
  let notifyRetry!: () => void;
  const retryNotified = new Promise<void>((resolve) => {
    notifyRetry = resolve;
  });
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("Rate limited"), {
              status: 429,
              headers: new Headers({ "retry-after": "60" }),
            });
          }
          return createChatStreamResponse([
            { choices: [{ delta: { content: "complete" }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          ]);
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: client as any, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmRetry: (event) => {
      retryDelayMs = event.delayMs;
      notifyRetry();
    },
  });

  const responsePromise = (manager as any).createChatCompletionStream(client, { model: "test-model" });
  await retryNotified;
  assert.equal(retryDelayMs, 60_000);
  t.mock.timers.tick(retryDelayMs);
  const response = await responsePromise;

  assert.equal(calls, 2);
  assert.equal(response.choices[0].message.content, "complete");
});

test("SessionManager treats a clean EOF without a terminal chunk as a disconnected stream", async () => {
  const controller = new AbortController();
  let retryError = "";
  const client = {
    chat: {
      completions: {
        create: async () => createChatStreamResponse([{ choices: [{ delta: { content: "partial" } }] }]),
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: client as any, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmRetry: (event) => {
      retryError = event.error;
      controller.abort();
    },
  });

  await assert.rejects(
    (manager as any).createChatCompletionStream(client, { model: "test-model" }, { signal: controller.signal }),
    (error: Error) => error.name === "AbortError"
  );
  assert.equal(retryError, "Model stream disconnected before completion.");
});

test("SessionManager retries a stream that is idle for sixty seconds after its first chunk", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let retryError = "";
  let nextCall = 0;
  const client = {
    chat: {
      completions: {
        create: async () => ({
          [Symbol.asyncIterator]() {
            return this;
          },
          next() {
            nextCall += 1;
            if (nextCall === 1) {
              return Promise.resolve({
                done: false,
                value: { choices: [{ delta: { content: "partial" } }] },
              });
            }
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        }),
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: client as any, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmRetry: (event) => {
      retryError = event.error;
      controller.abort();
    },
  });

  const responsePromise = (manager as any).createChatCompletionStream(
    client,
    { model: "test-model" },
    { signal: controller.signal }
  );
  for (let turn = 0; turn < 10 && nextCall < 2; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(nextCall, 2);
  t.mock.timers.tick(60_000);
  await Promise.resolve();

  await assert.rejects(responsePromise, (error: Error) => error.name === "AbortError");
  assert.equal(retryError, "Model stream was idle for 60 seconds.");
});

test("SessionManager gives first-chunk prefill five minutes and does not replay it after timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let retries = 0;
  let nextCalls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => ({
          [Symbol.asyncIterator]() {
            return this;
          },
          next() {
            nextCalls += 1;
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        }),
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: client as any, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmRetry: () => {
      retries += 1;
    },
  });

  const responsePromise = (manager as any).createChatCompletionStream(client, { model: "test-model" });
  for (let turn = 0; turn < 10 && nextCalls < 1; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(nextCalls, 1);
  t.mock.timers.tick(300_000);
  await Promise.resolve();

  await assert.rejects(
    responsePromise,
    (error: Error) =>
      error.name === "LlmStreamFirstChunkTimeoutError" &&
      error.message === "Model stream produced no first chunk for 300 seconds."
  );
  assert.equal(retries, 0);
});

test("SessionManager persists session and user message before skill matching is cancelled", async () => {
  const workspace = createTempDir("deepcode-skill-abort-workspace-");
  const home = createTempDir("deepcode-skill-abort-home-");
  setHomeDir(home);

  const skillDir = path.join(home, ".agents", "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n", "utf8");

  // eslint-disable-next-line prefer-const -- must be declared before client which references it
  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          assert.equal(request.temperature, 0.1);
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
            queueMicrotask(() => manager.interruptActiveSession());
          });
        },
      },
    },
  };

  manager = createMockedClientSessionManagerWithClient(workspace, client);

  await manager.handleUserPrompt({ text: "please use demo" });

  // Session and user message are persisted before skill matching triggers an abort.
  assert.equal(manager.listSessions().length, 1);
  const [session] = manager.listSessions();
  assert.equal(session?.status, "pending");
  const messages = manager.listSessionMessages(session!.id);
  const userMessage = messages.find((m) => m.role === "user");
  assert.equal(userMessage?.content, "please use demo");
});

test("SessionManager treats OpenAI APIUserAbortError as interrupted", async () => {
  const workspace = createTempDir("deepcode-api-abort-workspace-");
  const home = createTempDir("deepcode-api-abort-home-");
  setHomeDir(home);

  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
          });
        },
      },
    },
  };

  // eslint-disable-next-line prefer-const -- declared before client, assigned after
  manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onSessionEntryUpdated: (entry) => {
      if (entry.status === "processing") {
        queueMicrotask(() => manager.interruptActiveSession());
      }
    },
  });

  await manager.handleUserPrompt({ text: "" });

  const activeSessionId = manager.getActiveSessionId();
  assert.ok(activeSessionId);
  const session = manager.getSession(activeSessionId);
  assert.equal(session?.status, "interrupted");
  assert.equal(session?.failReason, "interrupted");
});

test("SessionManager marks MCP server as failed on single failed attempt (no auto-retry)", async () => {
  const workspace = createTempDir("deepcode-mcp-fail-noworkspace-");
  const serverPath = path.join(workspace, "mcp-server-fail.cjs");
  fs.writeFileSync(serverPath, "process.exit(7);", "utf8");

  const manager = createSessionManager(workspace, "machine-id-mcp-fail-no");
  await manager.initMcpServers({ broken: { command: process.execPath, args: [serverPath] } });

  const status = manager.getMcpStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0]?.status, "failed");
  assert.match(status[0]?.error ?? "", /exited with code 7/);

  manager.dispose();
});

test("SessionManager reconnect succeeds on previously failed server", async () => {
  const workspace = createTempDir("deepcode-mcp-reconn-ok-workspace-");
  const serverPath = path.join(workspace, "mcp-server-ok.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
});
`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-mcp-reconn-ok");
  await manager.initMcpServers({ fixable: { command: process.execPath, args: [serverPath] } });

  const status = manager.getMcpStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0]?.status, "ready");
  assert.equal(status[0]?.toolCount, 1);

  manager.dispose();
});

test("SessionManager adjusts the active Bash timeout control and session metadata", async () => {
  const workspace = createTempDir("deepcode-bash-timeout-session-");
  const home = createTempDir("deepcode-bash-timeout-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "");
  const sessionId = await manager.createSession({ text: "hello" });

  (manager as any).addSessionProcess(sessionId, 123, "sleep 10");

  let timeoutInfo = {
    timeoutMs: 10 * 60 * 1000,
    startedAtMs: 1000,
    deadlineAtMs: 1000 + 10 * 60 * 1000,
    timedOut: false,
  };
  (manager as any).setSessionProcessTimeoutControl(sessionId, 123, {
    getInfo: () => timeoutInfo,
    setTimeoutMs: (timeoutMs: number) => {
      timeoutInfo = {
        ...timeoutInfo,
        timeoutMs,
        deadlineAtMs: timeoutInfo.startedAtMs + timeoutMs,
      };
      return timeoutInfo;
    },
  });

  const adjustment = manager.adjustActiveBashTimeout(5 * 60 * 1000);
  const processInfo = manager.getSession(sessionId)?.processes?.get("123");

  assert.equal(adjustment?.processId, "123");
  assert.equal(adjustment?.timeoutMs, 15 * 60 * 1000);
  assert.equal(processInfo?.timeoutMs, 15 * 60 * 1000);
  assert.equal(processInfo?.deadlineAt, new Date(timeoutInfo.deadlineAtMs).toISOString());
});

test("SessionManager.deleteSession removes session entry from the index", () => {
  const workspace = createTempDir("deepcode-delete-workspace-");
  const home = createTempDir("deepcode-delete-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete");
  (manager as any).activateSession = async () => {};

  // Create two sessions
  const session1 = createSessionAndMessages(manager, "session-delete-1", "First session");
  const session2 = createSessionAndMessages(manager, "session-delete-2", "Second session");

  assert.equal(manager.listSessions().length, 2);

  // Delete the first session
  const result = manager.deleteSession(session1);
  assert.equal(result, true);

  const remaining = manager.listSessions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, session2);
});

test("SessionManager.deleteSession removes the messages file", () => {
  const workspace = createTempDir("deepcode-delete-msg-workspace-");
  const home = createTempDir("deepcode-delete-msg-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-msg");
  (manager as any).activateSession = async () => {};

  const sessionId = createSessionAndMessages(manager, "session-delete-msg", "Test session");
  const messagePath = path.join(home, ".deepcode", "projects", getProjectCode(workspace), `${sessionId}.jsonl`);

  // Verify messages file exists
  assert.ok(fs.existsSync(messagePath));

  manager.deleteSession(sessionId);

  // Verify messages file is removed
  assert.equal(fs.existsSync(messagePath), false);
});

test("sessions persist pasted images as file URLs without changing user content", async () => {
  const workspace = createTempDir("deepcode-session-image-workspace-");
  const home = createTempDir("deepcode-session-image-home-");
  setHomeDir(home);
  const manager = createSessionManagerForModel(workspace, "deepseek-chat");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({
    text: "Inspect these images",
    imageUrls: ["data:image/png;base64,aGVsbG8=", "data:image/webp;base64,d29ybGQ="],
  });
  const imagesDir = path.join(home, ".deepcode", "projects", getProjectCode(workspace), "images", sessionId);
  const imageFiles = fs.readdirSync(imagesDir).sort();
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");

  assert.equal(imageFiles.length, 2);
  assert.deepEqual(imageFiles.map((file) => path.extname(file)).sort(), [".png", ".webp"]);
  assert.equal(userMessage?.content, "Inspect these images");
  assert.equal(userMessage?.contentParams, null);
  const storedImageUrls = userMessage?.meta?.userPrompt?.imageUrls ?? [];
  assert.equal(storedImageUrls.length, 2);
  assert.deepEqual(
    storedImageUrls.map((url) => path.dirname(fileURLToPath(url))),
    [imagesDir, imagesDir]
  );

  manager.deleteSession(sessionId);
  assert.equal(fs.existsSync(imagesDir), false);
});

test("native multimodal sessions persist pasted images without storing inline content", async () => {
  const workspace = createTempDir("deepcode-native-image-workspace-");
  const home = createTempDir("deepcode-native-image-home-");
  setHomeDir(home);
  const manager = createSessionManagerForModel(workspace, "custom-vision-model");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ imageUrls: ["data:image/png;base64,aGVsbG8="] });
  const imagesDir = path.join(home, ".deepcode", "projects", getProjectCode(workspace), "images", sessionId);
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");

  assert.equal(fs.existsSync(imagesDir), true);
  assert.equal(userMessage?.content, "");
  assert.equal(userMessage?.contentParams, null);
  assert.equal(userMessage?.meta?.userPrompt?.imageUrls?.[0]?.startsWith("file://"), true);
});

test("multimodal off forces non-multimodal image handling for a multimodal model", async () => {
  const workspace = createTempDir("deepcode-multimodal-off-workspace-");
  const home = createTempDir("deepcode-multimodal-off-home-");
  setHomeDir(home);
  const manager = createSessionManagerForModel(workspace, "custom-vision-model", "off");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ imageUrls: ["data:image/png;base64,aGVsbG8="] });
  const imagesDir = path.join(home, ".deepcode", "projects", getProjectCode(workspace), "images", sessionId);
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");

  assert.equal(fs.existsSync(imagesDir), true);
  assert.equal(userMessage?.content, "");
  assert.equal(userMessage?.contentParams, null);
});

test("multimodal on persists images for a non-multimodal model", async () => {
  const workspace = createTempDir("deepcode-multimodal-on-workspace-");
  const home = createTempDir("deepcode-multimodal-on-home-");
  setHomeDir(home);
  const manager = createSessionManagerForModel(workspace, "deepseek-chat", "on");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ imageUrls: ["data:image/png;base64,aGVsbG8="] });
  const imagesDir = path.join(home, ".deepcode", "projects", getProjectCode(workspace), "images", sessionId);
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");

  assert.equal(fs.existsSync(imagesDir), true);
  assert.equal(userMessage?.content, "");
  assert.equal(userMessage?.contentParams, null);
});

test("multimodal requests send normalized image content without path metadata", async () => {
  const workspace = createTempDir("deepcode-multimodal-payload-workspace-");
  const home = createTempDir("deepcode-multimodal-payload-home-");
  setHomeDir(home);
  let request: any;
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          if (isSkillMatchingRequest(body)) {
            return createSkillMatchingResponse();
          }
          request = body;
          return createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({ client: client as any, model: "custom-vision-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "custom-vision-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    loadSharp: async () => sharp,
  });

  const sessionId = await manager.createSession({
    text: "Describe this image",
    imageUrls: [await createOnePixelPngDataUrl()],
  });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  const requestUserMessage = request.messages.find((message: any) => message.role === "user");

  assert.equal(userMessage?.contentParams, null);
  assert.deepEqual(requestUserMessage.content[0], { type: "text", text: "Describe this image" });
  assert.match(requestUserMessage.content[1].image_url.url, /^data:image\/(?:png|jpeg|webp);base64,/);
  assert.equal(requestUserMessage.content.length, 2);
});

test("non-multimodal requests send text and image metadata without loading Sharp", async () => {
  const workspace = createTempDir("deepcode-non-multimodal-payload-workspace-");
  const home = createTempDir("deepcode-non-multimodal-payload-home-");
  setHomeDir(home);
  const imagePath = path.join(workspace, "local image.png");
  fs.writeFileSync(imagePath, "not decoded for non-multimodal requests");
  let request: any;
  let sharpLoads = 0;
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          if (isSkillMatchingRequest(body)) {
            return createSkillMatchingResponse();
          }
          request = body;
          return createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      apiKey: "sk-files-test",
      model: "deepseek-chat",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "deepseek-chat", filesApiEnabled: true }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    loadSharp: async () => {
      sharpLoads += 1;
      return sharp;
    },
  });
  (manager as any).deepSeekFiles = {
    ensureUploaded: async () => assert.fail("non-multimodal images must not be uploaded"),
    invalidate: () => {},
  };

  const sessionId = await manager.createSession({
    text: "Describe this image",
    imageUrls: [pathToFileURL(imagePath).href],
  });
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  const requestUserMessage = request.messages.find((message: any) => message.role === "user");

  assert.equal(sharpLoads, 0);
  assert.equal(userMessage?.contentParams, null);
  assert.deepEqual(userMessage?.meta?.userPrompt?.imageUrls, [pathToFileURL(imagePath).href]);
  assert.deepEqual(requestUserMessage.content, [
    { type: "text", text: "Describe this image" },
    {
      type: "text",
      text: `<message_meta>\n${JSON.stringify({ images: [imagePath] }, null, 2)}\n</message_meta>`,
    },
  ]);
});

test("Files API mode reuses one upload for duplicate images without path metadata", async () => {
  const workspace = createTempDir("deepcode-files-session-workspace-");
  const home = createTempDir("deepcode-files-session-home-");
  setHomeDir(home);
  let request: any;
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          if (isSkillMatchingRequest(body)) {
            return createSkillMatchingResponse();
          }
          request = body;
          return createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      apiKey: "sk-files-test",
      model: "custom-vision-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "custom-vision-model", filesApiEnabled: true }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    loadSharp: async () => sharp,
  });
  let uploads = 0;
  (manager as any).deepSeekFiles = {
    ensureUploaded: async () => {
      uploads += 1;
      return { fileId: "file-image-1", imageHash: "a".repeat(64), bytes: 5 };
    },
    invalidate: () => {},
  };

  const imageDataUrl = await createOnePixelPngDataUrl();
  const sessionId = await manager.createSession({
    text: "Describe this image",
    imageUrls: [imageDataUrl, imageDataUrl],
  });
  const imagesDir = path.join(home, ".deepcode", "projects", getProjectCode(workspace), "images", sessionId);
  const userMessage = manager.listSessionMessages(sessionId).find((message) => message.role === "user");
  const requestUserMessage = request.messages.find((message: any) => message.role === "user");

  assert.equal(fs.existsSync(imagesDir), true);
  assert.equal(userMessage?.contentParams, null);
  assert.equal(uploads, 1);
  assert.deepEqual(requestUserMessage.content, [
    { type: "text", text: "Describe this image" },
    { type: "file", file_id: "file-image-1" },
    { type: "file", file_id: "file-image-1" },
  ]);
});

test("Files API mode fails the session when image upload fails", async () => {
  const workspace = createTempDir("deepcode-files-failure-workspace-");
  const home = createTempDir("deepcode-files-failure-home-");
  setHomeDir(home);
  const client = { chat: { completions: { create: async () => assert.fail("chat request must not start") } } };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      apiKey: "sk-files-test",
      model: "custom-vision-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "custom-vision-model", filesApiEnabled: true }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    loadSharp: async () => sharp,
  });
  (manager as any).deepSeekFiles = {
    ensureUploaded: async () => {
      throw new Error("upload unavailable");
    },
    invalidate: () => {},
  };

  const sessionId = await manager.createSession({ imageUrls: [await createOnePixelPngDataUrl()] });

  assert.equal(manager.getSession(sessionId)?.status, "failed");
  assert.match(manager.getSession(sessionId)?.failReason ?? "", /upload unavailable/);
});

test("Files API mode invalidates a rejected file ID and uploads it once more", async () => {
  const workspace = createTempDir("deepcode-files-stale-workspace-");
  const home = createTempDir("deepcode-files-stale-home-");
  setHomeDir(home);
  const requests: any[] = [];
  const rejected = Object.assign(new Error("file_id expired"), { status: 400 });
  const client = {
    chat: {
      completions: {
        create: async (body: any) => {
          requests.push(body);
          if (requests.length === 1) {
            throw rejected;
          }
          return createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        },
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      apiKey: "sk-files-test",
      model: "custom-vision-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "custom-vision-model", filesApiEnabled: true }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    loadSharp: async () => sharp,
  });
  let uploads = 0;
  let invalidations = 0;
  (manager as any).deepSeekFiles = {
    ensureUploaded: async () => {
      uploads += 1;
      return { fileId: `file-image-${uploads}`, imageHash: "a".repeat(64), bytes: 5 };
    },
    invalidate: () => {
      invalidations += 1;
    },
  };

  const sessionId = await manager.createSession({ imageUrls: [await createOnePixelPngDataUrl()] });

  assert.equal(manager.getSession(sessionId)?.status, "completed");
  assert.equal(invalidations, 1);
  assert.equal(uploads, 2);
  const retriedUserMessage = requests[1].messages.find((message: any) => message.role === "user");
  assert.deepEqual(retriedUserMessage.content, [{ type: "file", file_id: "file-image-2" }]);
});

test("Files API mode checks the aggregate request limit before uploading", async () => {
  const workspace = createTempDir("deepcode-files-limit-workspace-");
  const home = createTempDir("deepcode-files-limit-home-");
  setHomeDir(home);
  const client = { chat: { completions: { create: async () => assert.fail("chat request must not start") } } };
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      apiKey: "sk-files-test",
      model: "custom-vision-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "custom-vision-model",
      filesApiEnabled: true,
      maxRequestFilesBytes: 4,
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    loadSharp: async () => sharp,
  });
  (manager as any).deepSeekFiles = {
    ensureUploaded: async () => assert.fail("upload must not start"),
    invalidate: () => {},
  };

  const sessionId = await manager.createSession({ imageUrls: [await createOnePixelPngDataUrl()] });

  assert.equal(manager.getSession(sessionId)?.status, "failed");
  assert.match(manager.getSession(sessionId)?.failReason ?? "", /configured 4-byte/);
});

test("sessions reject unsupported pasted image data before creating a session", async () => {
  const workspace = createTempDir("deepcode-invalid-image-workspace-");
  const home = createTempDir("deepcode-invalid-image-home-");
  setHomeDir(home);
  const manager = createSessionManagerForModel(workspace, "deepseek-chat");
  (manager as any).activateSession = async () => {};

  await assert.rejects(
    manager.createSession({ imageUrls: ["data:image/bmp;base64,aGVsbG8="] }),
    /Only GIF, JPEG, PNG, and WebP/
  );
  assert.equal(manager.listSessions().length, 0);
});

test("forkSession copies image resources and rewrites stored paths", async () => {
  if (!hasGit()) {
    return;
  }
  const workspace = createTempDir("deepcode-fork-image-workspace-");
  const home = createTempDir("deepcode-fork-image-home-");
  setHomeDir(home);
  const manager = createSessionManagerForModel(workspace, "deepseek-chat");
  (manager as any).activateSession = async () => {};
  const sourceSessionId = await manager.createSession({ imageUrls: ["data:image/png;base64,aGVsbG8="] });
  const forkedSessionId = manager.forkSession(sourceSessionId);
  const projectImagesDir = path.join(home, ".deepcode", "projects", getProjectCode(workspace), "images");
  const sourceDir = path.join(projectImagesDir, sourceSessionId);
  const forkedDir = path.join(projectImagesDir, forkedSessionId);
  const forkedUserMessage = manager.listSessionMessages(forkedSessionId).find((message) => message.role === "user");

  assert.equal(fs.readdirSync(forkedDir).length, 1);
  const forkedImageUrl = forkedUserMessage?.meta?.userPrompt?.imageUrls?.[0] ?? "";
  assert.equal(fileURLToPath(forkedImageUrl).startsWith(forkedDir), true);
  assert.equal(fileURLToPath(forkedImageUrl).startsWith(sourceDir), false);

  manager.deleteSession(sourceSessionId);
  assert.equal(fs.existsSync(sourceDir), false);
  assert.equal(fs.existsSync(forkedDir), true);
});

test("SessionManager.deleteSession returns false when session does not exist", () => {
  const workspace = createTempDir("deepcode-delete-nonexist-workspace-");
  const home = createTempDir("deepcode-delete-nonexist-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-nonexist");

  const result = manager.deleteSession("nonexistent-session-id");
  assert.equal(result, false);
  assert.equal(manager.listSessions().length, 0);
});

test("SessionManager.deleteSession does not affect other sessions", () => {
  const workspace = createTempDir("deepcode-delete-others-workspace-");
  const home = createTempDir("deepcode-delete-others-home-");
  setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-delete-others");
  (manager as any).activateSession = async () => {};

  const session1 = createSessionAndMessages(manager, "session-keep-1", "Keep session 1");
  const session2 = createSessionAndMessages(manager, "session-keep-2", "Keep session 2");

  // Delete non-existent session
  const result = manager.deleteSession("non-existent");
  assert.equal(result, false);
  assert.equal(manager.listSessions().length, 2);

  // Delete one session
  assert.equal(manager.deleteSession(session1), true);
  assert.equal(manager.listSessions().length, 1);
  assert.equal(manager.listSessions()[0]?.id, session2);

  // The remaining session should still have its messages accessible
  const messages = manager.listSessionMessages(session2);
  assert.ok(messages.length > 0);
});

test("SessionManager.forkSession copies conversation state with fresh usage and independent file history", () => {
  if (!hasGit()) {
    return;
  }

  const workspace = createTempDir("deepcode-fork-workspace-");
  const home = createTempDir("deepcode-fork-home-");
  setHomeDir(home);
  const manager = createSessionManager(workspace, "machine-id-fork");
  const sourceSessionId = createSessionAndMessages(manager, "source-session", "Fork source");
  const now = "2026-01-01T00:00:00.000Z";
  const index = (manager as any).loadSessionsIndex();
  index.entries[0] = {
    ...index.entries[0],
    assistantReply: "Source reply",
    assistantThinking: "Source thinking",
    assistantRefusal: "old refusal",
    toolCalls: [{ id: "old-call" }],
    status: "failed",
    failReason: "old failure",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, total_reqs: 1 },
    usagePerModel: {
      "test-model": { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, total_reqs: 1 },
    },
    activeTokens: 15,
    processes: new Map([["123", { startTime: now, command: "sleep 10" }]]),
    askPermissions: [{ toolCallId: "old-call", name: "bash", command: "sleep 10", scopes: ["unknown"] }],
    planMode: true,
  };
  (manager as any).saveSessionsIndex(index);

  const sourceMessages: SessionMessage[] = [
    {
      id: "source-user-message",
      sessionId: sourceSessionId,
      role: "user",
      content: "Fork source",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    },
    {
      id: "source-head-message",
      sessionId: sourceSessionId,
      role: "assistant",
      content: "Source reply",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
    },
  ];
  (manager as any).saveSessionMessages(sourceSessionId, sourceMessages);

  const trackedPath = path.join(workspace, "tracked.txt");
  fs.writeFileSync(trackedPath, "source", "utf8");
  const fileHistory = new GitFileHistory(workspace, getFileHistoryGitDir(home, workspace));
  const sourceCheckpoint = fileHistory.recordCheckpoint(sourceSessionId, [trackedPath], "source checkpoint");
  assert.ok(sourceCheckpoint);

  const forkedSessionId = manager.forkSession(sourceSessionId);
  const forked = manager.getSession(forkedSessionId);
  assert.ok(forked);
  assert.deepEqual(forked.forkedFrom, {
    sessionId: sourceSessionId,
    messageId: "source-head-message",
  });
  assert.equal(forked.usage, null);
  assert.equal(forked.usagePerModel, null);
  assert.equal(forked.activeTokens, 15);
  assert.equal(forked.intentNarrationRejections, 0);
  assert.equal(forked.status, "completed");
  assert.equal(forked.failReason, null);
  assert.equal(forked.assistantRefusal, null);
  assert.equal(forked.toolCalls, null);
  assert.equal(forked.processes, null);
  assert.equal(forked.askPermissions, undefined);
  assert.equal(forked.planMode, true);

  const forkedMessages = manager.listSessionMessages(forkedSessionId);
  assert.deepEqual(
    forkedMessages.map((message) => ({ id: message.id, sessionId: message.sessionId, content: message.content })),
    sourceMessages.map((message) => ({ id: message.id, sessionId: forkedSessionId, content: message.content }))
  );
  assert.deepEqual(manager.listSessionMessages(sourceSessionId), sourceMessages);
  assert.equal(fileHistory.getCurrentCheckpointHash(forkedSessionId), sourceCheckpoint);

  fs.writeFileSync(trackedPath, "forked", "utf8");
  const forkedCheckpoint = fileHistory.recordCheckpoint(forkedSessionId, [trackedPath], "fork checkpoint");
  assert.ok(forkedCheckpoint);
  assert.notEqual(forkedCheckpoint, sourceCheckpoint);
  assert.equal(fileHistory.getCurrentCheckpointHash(sourceSessionId), sourceCheckpoint);
});

test("SessionManager ignores malformed fork lineage in persisted entries", () => {
  const workspace = createTempDir("deepcode-fork-lineage-workspace-");
  const home = createTempDir("deepcode-fork-lineage-home-");
  setHomeDir(home);
  const manager = createSessionManager(workspace, "machine-id-fork-lineage");
  const sessionId = createSessionAndMessages(manager, "lineage-session", "Lineage");
  const projectDir = (manager as any).getProjectStorage().projectDir;
  const indexPath = path.join(projectDir, "sessions-index.json");
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  persisted.entries[0].forkedFrom = { sessionId: sessionId };
  fs.writeFileSync(indexPath, JSON.stringify(persisted), "utf8");

  assert.equal(manager.getSession(sessionId)?.forkedFrom, undefined);
});

test("SessionManager persists plugin rate limits with UnderstandImage priority and does not copy them to forks", () => {
  const workspace = createTempDir("deepcode-plugin-rate-limit-workspace-");
  const home = createTempDir("deepcode-plugin-rate-limit-home-");
  setHomeDir(home);
  const manager = createSessionManager(workspace, "machine-id-plugin-rate-limit");
  const sessionId = createSessionAndMessages(manager, "plugin-rate-limit-session", "Rate limited");

  (manager as any).recordPluginRateLimitExceeded(sessionId, "WebSearch");
  assert.equal(manager.getSession(sessionId)?.pluginRateLimitedTool, "WebSearch");

  (manager as any).recordPluginRateLimitExceeded(sessionId, "UnderstandImage");
  (manager as any).recordPluginRateLimitExceeded(sessionId, "WebSearch");
  assert.equal(manager.getSession(sessionId)?.pluginRateLimitedTool, "UnderstandImage");

  const reloaded = createSessionManager(workspace, "machine-id-plugin-rate-limit");
  assert.equal(reloaded.getSession(sessionId)?.pluginRateLimitedTool, "UnderstandImage");

  const forkedSessionId = reloaded.forkSession(sessionId);
  assert.equal(reloaded.getSession(forkedSessionId)?.pluginRateLimitedTool, undefined);
});

test("SessionManager ignores malformed plugin rate limit tools in persisted entries", () => {
  const workspace = createTempDir("deepcode-plugin-rate-limit-malformed-workspace-");
  const home = createTempDir("deepcode-plugin-rate-limit-malformed-home-");
  setHomeDir(home);
  const manager = createSessionManager(workspace, "machine-id-plugin-rate-limit-malformed");
  const sessionId = createSessionAndMessages(manager, "plugin-rate-limit-malformed", "Malformed");
  const projectDir = (manager as any).getProjectStorage().projectDir;
  const indexPath = path.join(projectDir, "sessions-index.json");
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  persisted.entries[0].pluginRateLimitedTool = "UnknownTool";
  fs.writeFileSync(indexPath, JSON.stringify(persisted), "utf8");

  assert.equal(manager.getSession(sessionId)?.pluginRateLimitedTool, undefined);
});

/**
 * Helper: creates a session and writes a few messages to it so we can test
 * that deleteSession removes both the index entry and the messages file.
 */
function createSessionAndMessages(manager: SessionManager, sessionId: string, summary: string): string {
  const now = new Date().toISOString();
  const index = (manager as any).loadSessionsIndex();
  index.entries.push({
    id: sessionId,
    summary,
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "completed",
    failReason: null,
    usage: null,
    usagePerModel: null,
    activeTokens: 0,
    createTime: now,
    updateTime: now,
    processes: null,
  });
  (manager as any).saveSessionsIndex(index);

  // Write a couple of message lines to the messages file
  const projectDir = (manager as any).getProjectStorage().projectDir;
  const messagePath = path.join(projectDir, `${sessionId}.jsonl`);
  const msg = JSON.stringify({
    id: "msg-1",
    sessionId,
    role: "user",
    content: summary,
    visible: true,
    createTime: now,
    updateTime: now,
  });
  fs.writeFileSync(messagePath, `${msg}\n`, "utf8");

  return sessionId;
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createFileHistoryCommit(
  home: string,
  workspace: string,
  sessionId: string,
  files: Record<string, string>
): string {
  const projectCode = getProjectCode(workspace);
  const gitDir = path.join(home, ".deepcode", "projects", projectCode, "file-history", ".git");
  const fileHistory = new GitFileHistory(workspace, gitDir);
  fileHistory.ensureSession(sessionId);

  const filePaths: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    filePaths.push(filePath);
  }
  const commitHash = fileHistory.recordCheckpoint(sessionId, filePaths, "checkpoint");
  assert.ok(commitHash);
  return commitHash;
}

function getFileHistoryGitDir(home: string, workspace: string): string {
  const projectCode = getProjectCode(workspace);
  return path.join(home, ".deepcode", "projects", projectCode, "file-history", ".git");
}

function readFileHistoryManifest(home: string, workspace: string, checkpointHash: string): any {
  const gitDir = getFileHistoryGitDir(home, workspace);
  return JSON.parse(
    runFileHistoryGit(gitDir, workspace, ["cat-file", "blob", `${checkpointHash}:.deepcode-file-history.json`])
  );
}

function runFileHistoryGit(
  gitDir: string,
  workspace: string,
  args: string[],
  input = "",
  env: NodeJS.ProcessEnv = process.env
): string {
  return execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "core.eol=lf", `--git-dir=${gitDir}`, `--work-tree=${workspace}`, ...args],
    {
      encoding: "utf8",
      input,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}

function createSessionManager(projectRoot: string, machineId: string): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      machineId,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

function createSessionManagerForModel(
  projectRoot: string,
  model: string,
  multimodal: MultimodalMode = "default"
): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: null,
      model,
      thinkingEnabled: false,
      machineId: "machine-id-image-test",
    }),
    getResolvedSettings: () => ({ model, multimodal }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

function countLoadedSkillMessages(messages: SessionMessage[], skillName: string): number {
  return messages.filter(
    (message) => ["system", "tool"].includes(message.role) && message.meta?.skill?.name === skillName
  ).length;
}

function createNotifyingSessionManager(
  projectRoot: string,
  responses: unknown[],
  notifyPath: string,
  notifyOutput: string
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          if (response instanceof Error) {
            throw response;
          }
          return response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      notify: notifyPath,
      env: {
        NOTIFY_OUTPUT: notifyOutput,
        STATUS: "stale-status",
        FAIL_REASON: "stale-failure",
        BODY: "stale-body",
        TITLE: "stale-title",
      },
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

function createMockedClientSessionManager(
  projectRoot: string,
  responses: unknown[],
  autoCompactWindow?: number
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model", autoCompactWindow }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

function createPermissionSessionManager(
  projectRoot: string,
  responses: unknown[],
  permissions: {
    allow: any[];
    deny: any[];
    ask: any[];
    defaultMode: "allowAll" | "askAll";
    addWorkingDirs?: string[];
  }
): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse();
          }
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        },
      },
    },
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      permissions: { ...permissions, addWorkingDirs: permissions.addWorkingDirs ?? [] },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

function createMockedClientSessionManagerWithClient(projectRoot: string, client: unknown): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
}

class APIUserAbortError extends Error {}

function isSkillMatchingRequest(request: any): boolean {
  return request?.response_format?.type === "json_object";
}

function createSkillMatchingResponse(skillNames: string[] = []): unknown {
  return { choices: [{ message: { content: JSON.stringify({ skillNames }) } }] };
}

function createChatResponse(content: string, usage: Record<string, unknown>): unknown {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

function createToolCallResponse(toolCalls: unknown[], usage: Record<string, unknown>): unknown {
  return {
    choices: [{ message: { content: "", tool_calls: toolCalls } }],
    usage,
  };
}

function buildTestMessage(
  id: string,
  sessionId: string,
  role: SessionMessage["role"],
  content: string
): SessionMessage {
  return {
    id,
    sessionId,
    role,
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
  };
}

async function* createChatStreamResponse(chunks: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createOnePixelPngDataUrl(): Promise<string> {
  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${image.toString("base64")}`;
}

function createNotifyRecorderScript(dir: string): string {
  const scriptPath = path.join(dir, "notify-recorder.cjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
const keys = ["DURATION", "STATUS", "FAIL_REASON", "BODY", "TITLE"];
const record = {};
for (const key of keys) {
  record[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
}
fs.appendFileSync(process.env.NOTIFY_OUTPUT, JSON.stringify(record) + "\\n", "utf8");
`,
    "utf8"
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function waitForNotifyRecords(
  outputPath: string,
  expectedCount: number
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(outputPath)) {
      const records = fs
        .readFileSync(outputPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (records.length >= expectedCount) {
        return records;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`expected ${expectedCount} notify records in ${outputPath}`);
}

async function waitForMcpStatus(manager: SessionManager, expectedStatus: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getMcpStatus()[0]?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`expected MCP status ${expectedStatus}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("stream previews combine only reasoning and content, sanitize text, and reset per request", async () => {
  const events: Array<{ phase: string; previewText?: string; estimatedTokens: number }> = [];
  const client = {
    chat: {
      completions: {
        create: async () =>
          createChatStreamResponse([
            { choices: [{ delta: { reasoning_content: "think\r" } }] },
            { choices: [{ delta: { reasoning: "\nnext\t" } }] },
            { choices: [{ delta: { content: "\u001b[31m中文👋\u001b[0m\nanswer\r!\u0007" } }] },
            {
              choices: [
                {
                  delta: {
                    refusal: "excluded",
                    tool_calls: [
                      { index: 0, id: "tool", type: "function", function: { name: "bash", arguments: "{}" } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ]),
      },
    },
  };
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({ client: client as any, model: "test-model", thinkingEnabled: false }),
    getResolvedSettings: () => ({ model: "test-model" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmStreamProgress: (event) => events.push(event),
  });
  for (let i = 0; i < 2; i++) {
    events.length = 0;
    const response = await (manager as any).createChatCompletionStream(
      client,
      { model: "test-model" },
      undefined,
      "preview-session"
    );
    assert.equal(events[0]?.phase, "start");
    assert.equal(events[0]?.previewText, undefined);
    assert.equal(events[1]?.previewText, "think ");
    assert.equal(events[2]?.previewText, "think next ");
    assert.equal(events[3]?.previewText, "think next 中文👋 answer !");
    const updates = events.filter((event) => event.phase === "update");
    assert.equal(updates.at(-1)?.previewText, "think next 中文👋 answer !");
    assert.ok(updates.at(-1)!.estimatedTokens > updates[2]!.estimatedTokens);
    assert.equal(events.at(-1)?.phase, "end");
    assert.equal(events.at(-1)?.previewText, undefined);
    assert.equal(response.choices[0].message.content, "\u001b[31m中文👋\u001b[0m\nanswer\r!\u0007");
  }
});

test("interrupt settles an active prompt waiting for an internal tool request", { timeout: 5000 }, async () => {
  const workspace = createTempDir("deepcode-cancel-tool-workspace-");
  setHomeDir(createTempDir("deepcode-cancel-tool-home-"));
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const client = {
    chat: {
      completions: {
        create: (_body: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            notifyStarted();
          }),
      },
    },
  };
  let enabled = false;
  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: enabled ? (client as any) : null,
      model: "test",
      thinkingEnabled: false,
      telemetryEnabled: false,
    }),
    getResolvedSettings: () => ({ model: "test" }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });
  const sessionId = await manager.createSession({ text: "" });
  manager.setActiveSessionId(sessionId);
  enabled = true;
  // Exercise handleUserPrompt's controller lifetime with a pending built-in tool batch.
  manager.replySession = async (_id, _prompt, controller) => {
    (manager as any).sessionControllers.set(sessionId, controller);
    await (manager as any).appendToolMessages(sessionId, [
      {
        id: "cancel-search",
        type: "function",
        function: { name: "WebSearch", arguments: '{"query":"query"}' },
      },
    ]);
  };
  const prompt = manager.handleUserPrompt({ text: "continue" });
  await started;
  manager.interruptActiveSession();
  await prompt;
  assert.equal(manager.getSession(sessionId)?.status, "interrupted");
  assert.equal((manager as any).activePromptController, null);
  assert.equal(
    manager.listSessionMessages(sessionId).some((message) => message.role === "tool"),
    false
  );
  let resumed = false;
  manager.replySession = async (_id, _prompt, controller) => {
    assert.equal(controller?.signal.aborted, false);
    resumed = true;
  };
  await manager.handleUserPrompt({ text: "next" });
  assert.equal(resumed, true);
});
