import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INTENT_NARRATION_GUARD_SETTINGS,
  findIntentNarrationPhrase,
  recordRejectionInWindow,
  shouldHardStopIntentNarration,
  type ResolvedIntentNarrationGuardSettings,
} from "../common/intent-narration-guard";

const settings: ResolvedIntentNarrationGuardSettings = {
  ...DEFAULT_INTENT_NARRATION_GUARD_SETTINGS,
  phrases: [...DEFAULT_INTENT_NARRATION_GUARD_SETTINGS.phrases],
};

test("intent narration guard rejects replayed prose-only stalls on their first turn", () => {
  const replayedStalls = [
    "Let me execute both now.",
    "Let me run both directly.",
    "I'll just call it now.",
    "Running it now.",
    "I'm going to run the command now.",
    "For real now — UpdatePlan.",
    "No more loops. Actually invoke.",
    "Let me update the plan now.",
    "Now let me set up A1c and proceed with the implementation.",
    "Let me fetch the policy documents next.",
    "A1c is set up. Now let me add the state comment, then port the documents.",
  ];

  for (const content of replayedStalls) {
    assert.ok(findIntentNarrationPhrase(content, false, settings), content);
  }
});

test("intent narration guard allows prose plus a real tool call unchanged", () => {
  assert.equal(findIntentNarrationPhrase("Let me run the existing tests.", true, settings), null);
});

test("intent narration guard allows a tool-only turn", () => {
  assert.equal(findIntentNarrationPhrase("", true, settings), null);
});

test("intent narration guard allows conversational let-me phrases", () => {
  assert.equal(findIntentNarrationPhrase("Let me know if you want more detail.", false, settings), null);
  assert.equal(findIntentNarrationPhrase("Let me explain why the test failed.", false, settings), null);
});

test("intent narration guard honors an overridden phrase list", () => {
  const overridden = { ...settings, phrases: ["ship it now"] };

  assert.equal(findIntentNarrationPhrase("Let me run it.", false, overridden), null);
  assert.equal(findIntentNarrationPhrase("SHIP IT NOW.", false, overridden), "ship it now");
});

test("intent narration guard normalizes curly apostrophes and whitespace", () => {
  assert.equal(findIntentNarrationPhrase("I’m   going to run the check.", false, settings), "I'm going to run");
});

test("intent narration hard-stops after four rejected turns in the last six", () => {
  let history: boolean[] = [];
  for (const rejected of [true, false, true, true, false, true]) {
    history = recordRejectionInWindow(history, rejected, settings.hardStopWindow);
  }

  assert.deepEqual(history, [true, false, true, true, false, true]);
  assert.equal(shouldHardStopIntentNarration(history, settings), true);
  assert.equal(shouldHardStopIntentNarration(history, { ...settings, hardStopRejections: 0 }), false);
});
