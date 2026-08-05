# Content Reasoning Preamble Isolation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an OpenAI-compatible upstream response that embeds an English reasoning preamble before `Reply as ... ---` from sending or persisting that preamble as user-visible text, while preserving it as foldable reasoning.

**Architecture:** Add one focused parser at the user-facing text boundary that recognizes only a complete `Reply as <role>, ... --- <final reply>` envelope. Reuse it in non-streaming model-response normalization to move the preamble into `reasoningText`, and in sanitization and reply guards as defense in depth; leave streaming behavior unchanged because content sent before the delimiter cannot be retracted safely.

**Tech Stack:** Node.js 20, CommonJS, built-in `assert`, existing OpenAI-compatible response parser and runtime test runner.

---

## Chunk 1: Regression And Minimal Fix

### Task 1: Specify the mixed-content envelope

**Files:**
- Modify: `tests/userFacingTextCot.test.js`
- Modify: `tests/userFacingReplyGuards.test.js`

- [x] **Step 1: Add failing sanitizer cases**

Add the real response shape and assert that only the text after the delimiter remains visible:

```js
const mixedContent = 'Two pigs, one shoving the other. Reply as Mizuki, 1:45am, casual, no brackets, no emoji, short chunks. --- 哈哈哈这个接得太准了吧';
assert.strictEqual(sanitizeUserFacingText(mixedContent), '哈哈哈这个接得太准了吧');
assert.strictEqual(
  sanitizeUserFacingText('普通讨论 Reply as Mizuki --- 不是模型输出格式。'),
  '普通讨论 Reply as Mizuki --- 不是模型输出格式。'
);
```

- [x] **Step 2: Add failing guard cases**

Assert that a complete envelope is unsafe, while ordinary mentions and incomplete markers are not:

```js
const mixedContent = 'Two pigs, one shoving the other. Reply as Mizuki, 1:45am, casual, no brackets, no emoji, short chunks. --- 哈哈哈这个接得太准了吧';
assert.strictEqual(isReasoningTraceLeak(mixedContent), true);
assert.strictEqual(isReasoningTraceLeak('普通讨论 Reply as Mizuki，没有分隔符。'), false);
assert.strictEqual(isReasoningTraceLeak('普通讨论 Reply as Mizuki --- 没有角色指令。'), false);
assert.strictEqual(isReasoningTraceLeak('普通讨论 Reply as   , casual --- 角色为空。'), false);
assert.strictEqual(isReasoningTraceLeak('普通讨论 Reply as Mizuki,   --- 指令为空。'), false);
```

- [x] **Step 3: Run the focused tests and verify failure**

Run: `node scripts/run-tests.js tests/userFacingTextCot.test.js tests/userFacingReplyGuards.test.js`

Expected: FAIL because the English preamble remains visible and the guard does not recognize this envelope.

### Task 2: Parse and isolate the envelope

**Files:**
- Modify: `utils/userFacingText.js`
- Modify: `utils/userFacingReplyGuards.js`

- [x] **Step 1: Implement one strict parser**

Add and export a parser that requires all four elements: non-empty preamble, `Reply as <role>,`, non-empty comma-delimited role instructions, and a later `---` delimiter with non-empty final text. Return `null` when the shape is incomplete.

```js
function splitReasoningPreamble(text = '') {
  const source = String(text || '');
  const marker = /(?:^|\r?\n|[\t ])Reply as[\t ]+([^\r\n,]{1,80}),([^\r\n]{1,240}?)[\t ]+---[\t ]*/i.exec(source);
  if (!marker || marker.index <= 0) return null;
  if (!marker[1].trim() || !marker[2].trim()) return null;
  const reasoningText = source.slice(0, marker.index).trim();
  const finalText = source.slice(marker.index + marker[0].length).trim();
  if (!reasoningText || !finalText) return null;
  return {
    reasoningText,
    visibleText: finalText
  };
}
```

- [x] **Step 2: Reuse the parser in sanitization and guards**

At the start of internal-reasoning sanitization, replace a recognized envelope with its `visibleText`. In `isReasoningTraceLeak`, return true when `splitReasoningPreamble(raw)` succeeds.

- [x] **Step 3: Run the focused tests and verify success**

Run: `node scripts/run-tests.js tests/userFacingTextCot.test.js tests/userFacingReplyGuards.test.js`

Expected: PASS.

### Task 3: Normalize non-streaming model responses

**Files:**
- Modify: `tests/modelServiceReasoning.test.js`
- Modify: `api/runtimeV2/model/service.js`

- [x] **Step 1: Add the failing model-service regression**

Return the real mixed envelope from the OpenAI-compatible stub and assert:

```js
assert.strictEqual(result.visibleText, '哈哈哈这个接得太准了吧');
assert.strictEqual(result.persistedText, '哈哈哈这个接得太准了吧');
assert.strictEqual(result.reasoningText, 'Two pigs, one shoving the other.');
```

Also cover an existing explicit `reasoning_content` value and assert the extracted preamble is appended with a blank line.

- [x] **Step 2: Run the model-service test and verify failure**

Run: `node scripts/run-tests.js tests/modelServiceReasoning.test.js`

Expected: FAIL because `requestAssistantMessage` currently returns mixed content unchanged.

- [x] **Step 3: Normalize at the response boundary**

After `extractMessageContent(response)`, call `splitReasoningPreamble(message.content)`. When matched, return a shallow copy with `content` set to `visibleText` and `reasoningText` set to the non-empty blank-line join of the upstream reasoning and extracted preamble.

- [x] **Step 4: Run the model-service test and verify success**

Run: `node scripts/run-tests.js tests/modelServiceReasoning.test.js`

Expected: PASS.

### Task 4: Verify persistence protection

**Files:**
- Modify: `tests/mainReplyDegenerationRuntime.test.js`

- [x] **Step 1: Add final-validation regression coverage**

Pass a mixed envelope through `createFinalValidateNode` and assert `finalReply`, `displayReply`, and `persistedReplyText` contain only the final Chinese reply.

- [x] **Step 2: Run all four focused tests**

Run: `node scripts/run-tests.js tests/modelServiceReasoning.test.js tests/userFacingTextCot.test.js tests/userFacingReplyGuards.test.js tests/mainReplyDegenerationRuntime.test.js`

Expected: PASS.

- [x] **Step 3: Run static and full verification**

Run: `npm run lint`

Run: `npm run typecheck`

Run: `npm test`

Run: `git diff --check`

Expected: all commands exit 0.

- [ ] **Step 4: Commit the implementation**

Stage only the plan and these seven source/test files: `utils/userFacingText.js`, `utils/userFacingReplyGuards.js`, `api/runtimeV2/model/service.js`, `tests/userFacingTextCot.test.js`, `tests/userFacingReplyGuards.test.js`, `tests/modelServiceReasoning.test.js`, and `tests/mainReplyDegenerationRuntime.test.js`. Commit with a scoped fix message; do not stage `.belt/`, `AGENT.md`, or `tests/maimaiAgentIntegration.test.js`.

## Chunk 2: Documentation And Evidence

### Task 5: Record the verified fix

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [ ] **Step 1: Add timestamped maintenance records**

Record the 2026-08-05 mixed-content root cause, the strict envelope split, the preserved foldable reasoning path, and exact verification results. State explicitly that the observed request used the administrator `claude-opus-5` non-streaming path rather than `gemini-3-flash-preview-search`.

- [ ] **Step 2: Verify documentation changes**

Run: `git diff --check`

Expected: exit 0.

- [ ] **Step 3: Commit documentation**

Stage only `README.md` and `docs/maintenance-log.md`, commit with a documentation message, and do not push.
