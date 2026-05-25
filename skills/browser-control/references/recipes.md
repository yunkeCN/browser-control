# Browser Control task recipes

These recipes are written for Agents running from the `skills/browser-control` directory. If `browser-control` is on `PATH`, the shorter command can replace `node scripts/browser-control.js`.

Use a unique session per task and close it when done.

## Shared command template

```bash
node scripts/browser-control.js command snapshot --session demo --args '{}'
```

Equivalent raw HTTP template:

```bash
curl -s http://127.0.0.1:10087/command \
  -H 'content-type: application/json' \
  -d '{"id":"req-1","version":"2026-05-19","session":"demo","command":"snapshot","args":{},"timeoutMs":30000}'
```

## Read a page

Use when the user asks you to inspect, summarize, or extract visible content from a page.

1. Start and verify readiness:
   ```bash
   node scripts/browser-control.js start --json
   node scripts/browser-control.js doctor --json
   ```
2. Navigate or find an existing tab:
   ```bash
   node scripts/browser-control.js command navigate --session read-page --args '{"url":"https://example.com","newTab":true}'
   ```
3. Capture compact page structure for targets and layout context:
   ```bash
   node scripts/browser-control.js command snapshot --session read-page --args '{}'
   ```
   For noisy pages, prefer snapshot filters before reading a broad structure snapshot:
   ```bash
   node scripts/browser-control.js command snapshot --session read-page --args '{"hasVisibleText":true,"viewportOnly":true}'
   ```
   Snapshot avoids repeating most parent container descendant text and redacts likely sensitive input values. It is still meant for interaction, not prose extraction.
4. If you only need visible text, use `get_text` instead of custom JavaScript or a broad snapshot:
   ```bash
   node scripts/browser-control.js command get_text --session read-page --args '{"scope":"viewport","maxChars":4000}'
   ```
5. For below-fold content or scrollable result regions, use first-class `scroll` rather than keyboard keys or an `evaluate` workaround, then read text again:
   ```bash
   node scripts/browser-control.js command scroll --session read-page --args '{"deltaY":800,"strategy":"dom"}'
   node scripts/browser-control.js command scroll --session read-page --args '{"strategy":"wheel","x":400,"y":500,"deltaY":800}'
   node scripts/browser-control.js command get_text --session read-page --args '{"scope":"full","maxChars":12000,"includeRuns":true}'
   ```
6. Report content with the source URL/session context. Close with `close_session` unless the user wants the tab left open.

Verification evidence: URL loaded, snapshot/get_text contains the content used in the answer.

Stop/ask conditions: login wall, MFA, CAPTCHA, paid content, or permission prompt.

## Operate UI safely

Use when clicking controls, opening menus, choosing options, or manipulating visible UI.

1. Take a fresh snapshot.
2. Identify the target by role/name/text and use its `@e` reference.
3. Perform the action:
   ```bash
   node scripts/browser-control.js command click --session ui-task --args '{"target":"@e1jm0sbb_1"}'
   ```
4. Inspect returned `changes` / `postSnapshot`, or verify with `wait_for` or screenshot.
5. If the UI changed, do not reuse old `@e` references; snapshot again.

Verification evidence: before/after snapshot or screenshot shows the intended state change.

Stop/ask conditions: action appears final/destructive/sensitive, or target identity is ambiguous.

## Fill a form without submitting

Use when preparing form fields but not sending the form yet.

1. Snapshot and identify each input/select/checkbox by `@e`.
2. Fill fields:
   ```bash
   node scripts/browser-control.js command fill --session form-draft --args '{"target":"@e0field_1","value":"example text"}'
   node scripts/browser-control.js command click --session form-draft --args '{"target":"@e0select_1"}'
   node scripts/browser-control.js command press --session form-draft --args '{"key":"ArrowDown"}'
   node scripts/browser-control.js command press --session form-draft --args '{"key":"Enter"}'
   node scripts/browser-control.js command click --session form-draft --args '{"target":"@e1jm0sbb_1"}'
   ```
3. Verify values with a fresh snapshot or targeted evaluate.
4. Stop before clicking Submit/Send/Confirm unless the user explicitly approved submission.

Verification evidence: values are visible or inspectable after fill.

Stop/ask conditions: personal/sensitive data, credentials, uploads, or any submission/final action.

## Submit or confirm an action

Use only when the user asked for a submission or final action.

1. Prepare the form/action state.
2. Summarize exactly what will be submitted or changed.
3. Ask for confirmation unless the current user instruction already explicitly authorizes this exact final action.
4. Snapshot, click the final control by `@e`, and verify result:
   ```bash
   node scripts/browser-control.js command click --session submit-task --args '{"target":"@e0submit_1","after":"snapshot"}'
   node scripts/browser-control.js command wait_for --session submit-task --args '{"text":"Success","timeoutMs":10000}'
   ```

Verification evidence: confirmation page, success message, resulting record, or error message.

Stop/ask conditions: uncertainty about consequences, payment, deletion, account/security changes, or legal/financial/medical impact.

## Capture a screenshot

Use screenshots for visual evidence, layout checks, or when text snapshots are insufficient.

```bash
node scripts/screenshot.js -s visual-check -f png
```

For a session-bound target tab, screenshot capture may briefly bring that tab to
the front, then best-effort restore the previously active tab.

Do not call the raw screenshot API in the conversation unless you intentionally want base64 output. Prefer reporting the saved file path.

Verification evidence: screenshot file path and, when relevant, a snapshot describing the page state.

## Save as PDF

Use when the user asks for an archival page export.

1. Navigate and wait until the page is ready.
2. Call `save_as_pdf`:
   ```bash
   node scripts/browser-control.js command save_as_pdf --session pdf-task --args '{"file_name":"page.pdf","paper_format":"A4","print_background":true}'
   ```
3. Report the artifact path returned by the response.

Verification evidence: response `artifacts` includes the PDF path.

Stop/ask conditions: page requires login/MFA or exporting sensitive documents without user approval.

## Inspect network calls

Use when the user asks which API a page calls or why data appears.

1. Start capture explicitly or rely on `navigate` starting API-focused capture:
   ```bash
   node scripts/browser-control.js command network_start --session net-task --args '{"filter":"api"}'
   ```
   `filter` is a URL substring string; omit it for no filtering. Network capture is API-focused and intentionally excludes non-XHR/fetch resources such as images, CSS, fonts, scripts, and document loads.
2. Navigate or perform the triggering UI action.
3. List requests:
   ```bash
   node scripts/browser-control.js command network_list --session net-task --args '{}'
   ```
4. Fetch details for relevant `requestId` values:
   ```bash
   node scripts/browser-control.js command network_detail --session net-task --args '{"requestId":"<id>"}'
   ```
5. Stop capture if done:
   ```bash
   node scripts/browser-control.js command network_stop --session net-task --args '{}'
   ```

Verification evidence: request URL, method, status, response metadata/body or artifact path.

Stop/ask conditions: traffic contains credentials, tokens, personal data, or private account information not needed for the task.

## Download a file

Use when the user asks to retrieve a browser-accessible file.

1. Navigate or directly call download when a URL is known:
   ```bash
   node scripts/browser-control.js command download --session dl-task --args '{"url":"https://example.com/file.csv","filename":"file.csv"}'
   ```
2. If download is triggered by a button, snapshot, click the `@e` target, then verify artifact/download metadata.
3. Report the local path or artifact metadata.

Verification evidence: downloaded path, filename, or artifact metadata.

Stop/ask conditions: downloading sensitive/private files, malware-risk content, or files behind permission prompts.

## Clean up

Always clean task-specific state unless the user asks to keep tabs open.

```bash
node scripts/browser-control.js command close_session --session demo --args '{}'
node scripts/session-cleanup.js --dry-run
```

Verification evidence: `close_session` response or `list_tabs` shows no remaining task tabs.


## Run multiline JavaScript safely

Avoid shell-escaping large snippets. Put the code in a UTF-8 file and use `--code-file` for `evaluate`:

```bash
node scripts/browser-control.js command evaluate --session js-task --code-file ./snippet.js
```

`evaluate` is intended to work on pages with strict script policies such as
Trusted Types. Prefer `get_text`, `wait_for`, and first-class commands when they
fit the task; reserve custom JavaScript for targeted inspection or extraction.

Use `--args-file` for large JSON command arguments. Browser Control intentionally does not support a `codeBase64` argument.
