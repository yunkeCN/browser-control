(function () {
  var COMMANDS = {
    navigate: { required: ["url"], example: { url: "https://example.com", newTab: true } },
    find_tab: { required: [], example: { titleIncludes: "Example", attach: true } },
    snapshot: { required: [], example: { viewportOnly: true, hasVisibleText: true, boxes: true } },
    click: { required: ["target"], example: { target: "@e1abc_1", after: "auto" } },
    click_probe: { required: ["target"], example: { target: "@e1abc_1", strategy: "auto", filter: "/api/" } },
    fill: { required: ["target", "value"], example: { target: "@e1input_2", value: "sample text", clear: true } },
    press: { required: ["key"], example: { key: "Enter" } },
    scroll: { required: [], example: { deltaY: 800, strategy: "dom" } },
    wait_for: { required: [], example: { text: "Ready", timeoutMs: 5000 } },
    evaluate: { required: ["code"], example: { code: "return { title: document.title, url: location.href }" } },
    screenshot: { required: [], example: { fullPage: true, format: "png" } },
    save_as_pdf: { required: [], example: { print_background: true, paper_format: "A4" } },
    observe_start: { required: [], example: { includeNetworkMarker: true } },
    observe_diff: { required: ["baselineId"], example: { baselineId: "obs_...", includeNetwork: true } },
    network_start: { required: [], example: { scope: "session", filter: "/api/" } },
    network_list: { required: [], example: { limit: 100, filter: "" } },
    network_detail: { required: ["requestId"], example: { requestId: "request-id-from-network-list" } },
    network_stop: { required: [], example: {} },
    upload: { required: ["target", "files"], example: { target: "@e1file_4", files: ["/tmp/example.png"] } },
    download: { required: ["url"], example: { url: "https://example.com/file.zip", filename: "file.zip" } },
    get_text: { required: [], example: { scope: "full", maxChars: 4000, includeRuns: true } },
    list_tabs: { required: [], example: {} },
    close_tab: { required: [], example: { tabId: 123 } },
    close_session: { required: [], example: {} }
  };

  var PRESETS = [
    { command: "navigate", title: "Open page", meta: "navigate url" },
    { command: "snapshot", title: "Inspect DOM", meta: "snapshot visible nodes" },
    { command: "click", title: "Click target", meta: "target @e id" },
    { command: "evaluate", title: "Run script", meta: "page runtime eval" },
    { command: "network_start", title: "Capture network", meta: "session scope" },
    { command: "network_list", title: "Read network", meta: "requests table" },
    { command: "get_text", title: "Extract text", meta: "full text runs" }
  ];

  var MOCK_NETWORK = [
    {
      method: "GET",
      status: 200,
      url: "https://app.example.internal/api/browser-control/sessions/default/snapshot?viewportOnly=true&includeAccessibilityTree=true&query=very-long-filter-value-that-should-wrap-inside-the-cell-instead-of-expanding-the-whole-page",
      type: "fetch",
      time: "34ms"
    },
    {
      method: "POST",
      status: 202,
      url: "https://app.example.internal/api/commands/click_probe",
      type: "xhr",
      time: "118ms"
    },
    {
      method: "GET",
      status: 304,
      url: "https://cdn.example.internal/assets/runtime/browser-control-agent-2026-05-26.js",
      type: "script",
      time: "7ms"
    },
    {
      method: "POST",
      status: 502,
      url: "https://app.example.internal/api/browser-control/network/detail/request-with-a-very-long-id-018fe5e48c3f4ffbac08f14d3a8bd289",
      type: "fetch",
      time: "1000ms"
    }
  ];

  var RISK_NOTES = {
    click: "Risk: may trigger page actions, submissions, navigation, or account-affecting UI. The MCP server does not perform user confirmation; callers must follow Browser Control safety boundaries.",
    click_probe: "Risk: still performs a real frontend click and may change page state, even while matching API requests are blocked. The MCP server does not perform user confirmation.",
    fill: "Risk: may place sensitive or private data into page fields. The MCP server does not perform user confirmation.",
    press: "Risk: may submit forms, activate focused controls, or navigate. The MCP server does not perform user confirmation.",
    evaluate: "Risk: executes JavaScript in the page context and can read page data (DOM, cookies, storage) or trigger side effects. The MCP server does not perform user confirmation.",
    upload: "Risk: uploads local files to the page. The MCP server does not perform user confirmation.",
    download: "Risk: downloads remote content through Chrome. The MCP server does not perform user confirmation.",
    save_as_pdf: "Risk: creates a page artifact that may contain sensitive visible content. The MCP server does not perform user confirmation.",
    network_detail: "Risk: may expose request/response headers or bodies that contain sensitive data. The MCP server does not perform user confirmation."
  };

  var state = {
    sessions: [{ name: "default", tabCount: 0, lastActivity: new Date().toISOString() }],
    history: [],
    logs: [],
    networkRows: MOCK_NETWORK.slice(),
    activeTab: "result",
    resultView: "daemon",
    logFilter: "all",
    lastResult: null,
    lastDuration: null
  };

  var $ = function (selector) {
    return document.querySelector(selector);
  };

  var els = {
    connectionForm: $("#connectionForm"),
    endpointInput: $("#endpointInput"),
    connectionPill: $("#connectionPill"),
    sessionList: $("#sessionList"),
    presetList: $("#presetList"),
    newSessionButton: $("#newSessionButton"),
    extensionMetric: $("#extensionMetric"),
    sessionsMetric: $("#sessionsMetric"),
    pendingMetric: $("#pendingMetric"),
    uptimeMetric: $("#uptimeMetric"),
    commandForm: $("#commandForm"),
    commandSelect: $("#commandSelect"),
    sessionInput: $("#sessionInput"),
    timeoutInput: $("#timeoutInput"),
    argsInput: $("#argsInput"),
    validateButton: $("#validateButton"),
    validationMessage: $("#validationMessage"),
    sendButton: $("#sendButton"),
    copyEnvelopeButton: $("#copyEnvelopeButton"),
    historyBlock: $("#historyBlock"),
    toggleHistoryButton: $("#toggleHistoryButton"),
    historyCount: $("#historyCount"),
    historyList: $("#historyList"),
    clearHistoryButton: $("#clearHistoryButton"),
    resultSummary: $("#resultSummary"),
    resultOutput: $("#resultOutput"),
    copyResultButton: $("#copyResultButton"),
    resultViewButtons: document.querySelectorAll("[data-result-view]"),
    networkFilterInput: $("#networkFilterInput"),
    refreshNetworkButton: $("#refreshNetworkButton"),
    networkTableBody: $("#networkTableBody"),
    logList: $("#logList"),
    clearLogsButton: $("#clearLogsButton"),
    toast: $("#toast")
  };

  function init() {
    populateCommands();
    renderPresets();
    bindEvents();
    selectCommand("navigate");
    setMockResult();
    renderSessions();
    renderNetwork();
    renderHistory();
    setHistoryExpanded(false);
    renderStatus({
      extension_connected: false,
      sessions: state.sessions,
      pendingRequests: 0,
      uptime_seconds: 0
    });
    addLog("info", "Console initialized.");
    refreshStatus(true);
    window.setInterval(function () {
      refreshStatus(true);
    }, 5000);
  }

  function populateCommands() {
    Object.keys(COMMANDS).forEach(function (command) {
      var option = document.createElement("option");
      option.value = command;
      option.textContent = command;
      els.commandSelect.appendChild(option);
    });
  }

  function bindEvents() {
    els.connectionForm.addEventListener("submit", function (event) {
      event.preventDefault();
      refreshStatus(false);
    });

    els.commandSelect.addEventListener("change", function () {
      selectCommand(els.commandSelect.value);
    });

    els.commandForm.addEventListener("submit", function (event) {
      event.preventDefault();
      executeCommand();
    });

    els.validateButton.addEventListener("click", function () {
      validateEnvelope(true);
    });

    els.copyEnvelopeButton.addEventListener("click", function () {
      var parsed = validateEnvelope(false);
      if (!parsed.ok) {
        setValidation(parsed.message, "error");
        return;
      }
      copyText(JSON.stringify(parsed.envelope, null, 2));
    });

    els.copyResultButton.addEventListener("click", function () {
      var text = els.resultOutput.textContent.trim();
      if (!text) {
        showToast("No result to copy.");
        return;
      }
      copyText(text);
    });

    els.resultViewButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        state.resultView = button.dataset.resultView || "daemon";
        renderResult();
      });
    });

    els.newSessionButton.addEventListener("click", function () {
      var name = "session-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      upsertSession({ name: name, tabCount: 0, lastActivity: new Date().toISOString() });
      els.sessionInput.value = name;
      renderSessions();
      addLog("info", "Created local session " + name + ".");
    });

    els.clearHistoryButton.addEventListener("click", function () {
      state.history = [];
      renderHistory();
    });

    els.toggleHistoryButton.addEventListener("click", function () {
      setHistoryExpanded(!els.historyBlock.classList.contains("is-expanded"));
    });

    document.querySelectorAll(".tab-button").forEach(function (button) {
      button.addEventListener("click", function () {
        setActiveTab(button.dataset.tab);
      });
    });

    els.networkFilterInput.addEventListener("input", renderNetwork);

    els.refreshNetworkButton.addEventListener("click", function () {
      els.commandSelect.value = "network_list";
      selectCommand("network_list");
      setActiveTab("network");
      executeCommand();
    });

    document.querySelectorAll("[data-log-filter]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.logFilter = button.dataset.logFilter;
        document.querySelectorAll("[data-log-filter]").forEach(function (candidate) {
          candidate.classList.toggle("active", candidate === button);
        });
        renderLogs();
      });
    });

    els.clearLogsButton.addEventListener("click", function () {
      state.logs = [];
      renderLogs();
    });
  }

  function selectCommand(command) {
    var spec = COMMANDS[command] || COMMANDS.navigate;
    els.commandSelect.value = command;
    els.argsInput.value = JSON.stringify(spec.example, null, 2);
    setValidation("", "");
    renderPresets();
  }

  function renderPresets() {
    els.presetList.replaceChildren();
    PRESETS.forEach(function (preset) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "preset-button";
      button.classList.toggle("active", preset.command === els.commandSelect.value);
      button.addEventListener("click", function () {
        selectCommand(preset.command);
      });

      var title = document.createElement("div");
      title.className = "preset-title";
      title.textContent = preset.title;
      var meta = document.createElement("div");
      meta.className = "preset-meta";
      meta.textContent = preset.meta;
      button.append(title, meta);
      els.presetList.appendChild(button);
    });
  }

  async function refreshStatus(quiet) {
    setConnection("loading", "Checking");
    try {
      var data = await fetchJson(joinUrl(endpoint(), "/status"));
      state.sessions = normalizeSessions(data.sessions);
      setConnection(data.extension_connected ? "online" : "offline", data.extension_connected ? "Online" : "No extension");
      renderStatus(data);
      renderSessions();
      if (!quiet) {
        addLog("info", "Status refreshed from " + endpoint() + ".");
      }
    } catch (error) {
      setConnection("offline", "Offline");
      renderStatus({
        extension_connected: false,
        sessions: state.sessions,
        pendingRequests: 0,
        uptime_seconds: 0
      });
      renderSessions();
      if (!quiet) {
        addLog("warn", "Status refresh failed: " + error.message);
      }
      if (!quiet) {
        showToast("Daemon status unavailable.");
      }
    }
  }

  async function executeCommand() {
    var parsed = validateEnvelope(false);
    if (!parsed.ok) {
      setValidation(parsed.message, "error");
      addLog("error", parsed.message);
      return;
    }

    setValidation("Envelope is valid.", "success");
    setButtonBusy(true);
    var started = performance.now();

    try {
      var result = await fetchJson(joinUrl(endpoint(), "/command"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.envelope)
      });
      var duration = Math.round(performance.now() - started);
      setResult(result, duration);
      pushHistory(parsed.envelope.command, Boolean(result.ok), duration);
      upsertSession({ name: parsed.envelope.session, tabCount: result.tab ? 1 : 0, lastActivity: new Date().toISOString() });
      renderSessions();
      addLog(result.ok ? "info" : "error", parsed.envelope.command + " completed in " + duration + "ms.");
      hydrateNetworkFromResult(result);
      setActiveTab(result.ok ? state.activeTab : "result");
    } catch (error) {
      var failResult = {
        ok: false,
        command: parsed.envelope.command,
        session: parsed.envelope.session,
        error: {
          code: "REQUEST_FAILED",
          message: error.message,
          retryable: true
        },
        diagnostics: {
          endpoint: endpoint()
        }
      };
      setResult(failResult, Math.round(performance.now() - started));
      pushHistory(parsed.envelope.command, false, null);
      addLog("error", parsed.envelope.command + " failed: " + error.message);
      setActiveTab("result");
    } finally {
      setButtonBusy(false);
    }
  }

  function validateEnvelope(showSuccess) {
    var args;
    var command = els.commandSelect.value;
    var spec = COMMANDS[command];

    try {
      args = els.argsInput.value.trim() ? JSON.parse(els.argsInput.value) : {};
    } catch (error) {
      return { ok: false, message: "Args JSON is invalid: " + error.message };
    }

    if (!args || Array.isArray(args) || typeof args !== "object") {
      return { ok: false, message: "Args JSON must be an object." };
    }

    var missing = spec.required.filter(function (field) {
      return args[field] === undefined || args[field] === null || args[field] === "";
    });

    if (missing.length) {
      return { ok: false, message: "Missing required args: " + missing.join(", ") + "." };
    }

    var timeoutMs = Number(els.timeoutInput.value);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
      return { ok: false, message: "Timeout must be at least 1000ms." };
    }

    var envelope = {
      command: command,
      session: cleanSessionName(els.sessionInput.value),
      args: args,
      timeoutMs: timeoutMs
    };

    if (showSuccess) {
      setValidation("Envelope is valid.", "success");
    }

    return { ok: true, envelope: envelope };
  }

  function setMockResult() {
    var longSelector = "main article[data-route='debug-console'] section[data-panel='network'] table tbody tr:nth-child(42) td.url-cell a[href*='very-long-filter-value-that-should-not-expand-the-layout']";
    setResult({
      ok: true,
      command: "snapshot",
      session: "default",
      tab: 108,
      data: {
        title: "Browser Control Fixture",
        url: "https://app.example.internal/debug/console?session=default&trace=018fe5e48c3f4ffbac08f14d3a8bd289&expanded=true&payload=long-value-for-overflow-testing",
        elements: [
          {
            id: "@e1demo_1",
            role: "button",
            name: "Run command",
            selector: longSelector,
            visibleText: "Run command"
          }
        ],
        diagnostics: {
          viewportOnly: true,
          totalNodes: 1284,
          note: "Sample payload is intentionally long so the JSON pane proves that data scrolls inside the inspector instead of expanding the whole page."
        }
      },
      diagnostics: {
        extensionConnected: true,
        pendingRequests: 0,
        warnings: []
      }
    }, 0);
  }

  function setResult(result, duration) {
    state.lastResult = result;
    state.lastDuration = duration;
    renderResult();
  }

  function renderResult() {
    if (!state.lastResult) return;
    var view = resultViewPayload(state.lastResult);
    var result = view.summary;
    var command = result.command || result.action || (result.request && result.request.command) || els.commandSelect.value;
    var session = result.session || (result.request && result.request.session) || els.sessionInput.value || "default";
    var stateText = result.ok ? "ok" : "error";
    var responseSize = view.sizeBytes;

    els.resultViewButtons.forEach(function (button) {
      button.classList.toggle("active", button.dataset.resultView === state.resultView);
    });

    els.resultSummary.replaceChildren(
      summaryCard("State", stateText),
      summaryCard("Command", command),
      summaryCard("Session", session),
      summaryCard("Duration", state.lastDuration ? state.lastDuration + "ms" : "--"),
      summaryCard("Size", formatBytes(responseSize)),
      summaryCard("Artifacts", Array.isArray(result.artifacts) ? String(result.artifacts.length) : "0")
    );

    els.resultOutput.textContent = view.text;
  }

  function resultViewPayload(rawResult) {
    if (state.resultView === "agent") {
      var structuredContent = buildAgentStructuredContent(rawResult);
      var toolResult = buildAgentToolResult(structuredContent);
      var text = JSON.stringify(toolResult, null, 2);
      return {
        summary: structuredContent,
        text: text,
        sizeBytes: byteLength(text)
      };
    }
    var daemonText = JSON.stringify(rawResult, null, 2);
    return {
      summary: rawResult,
      text: daemonText,
      sizeBytes: byteLength(daemonText)
    };
  }

  function buildAgentStructuredContent(rawResult) {
    var command = rawResult.command || els.commandSelect.value;
    var session = rawResult.session || els.sessionInput.value || "default";
    var structuredContent = Object.assign({}, rawResult, {
      command: typeof rawResult.command === "string" ? rawResult.command : command,
      session: typeof rawResult.session === "string" ? rawResult.session : session
    });
    if (RISK_NOTES[command] && !Array.isArray(structuredContent.riskNotes)) {
      structuredContent.riskNotes = [RISK_NOTES[command]];
    }
    structuredContent.activeSession = session;
    return structuredContent;
  }

  function buildAgentToolResult(structuredContent) {
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: structuredContent,
      isError: structuredContent.ok === false
    };
  }

  function summaryCard(label, value) {
    var node = document.createElement("div");
    node.className = "summary-card";
    var labelNode = document.createElement("span");
    labelNode.textContent = label;
    var valueNode = document.createElement("strong");
    valueNode.textContent = value;
    node.append(labelNode, valueNode);
    return node;
  }

  function renderStatus(data) {
    els.extensionMetric.textContent = data.extension_connected ? "Connected" : "Disconnected";
    els.sessionsMetric.textContent = String(Array.isArray(data.sessions) ? data.sessions.length : 0);
    els.pendingMetric.textContent = String(data.pendingRequests || data.pending_requests || 0);
    els.uptimeMetric.textContent = formatUptime(data.uptime_seconds || data.uptimeSeconds || 0);
  }

  function renderSessions() {
    var current = cleanSessionName(els.sessionInput.value);
    var sessions = normalizeSessions(state.sessions);
    els.sessionList.replaceChildren();

    sessions.forEach(function (session) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "session-item";
      button.classList.toggle("active", session.name === current);
      button.addEventListener("click", function () {
        els.sessionInput.value = session.name;
        renderSessions();
      });

      var copy = document.createElement("div");
      var name = document.createElement("div");
      name.className = "session-name";
      name.textContent = session.name;
      var meta = document.createElement("div");
      meta.className = "session-meta";
      meta.textContent = session.lastActivity ? "last " + formatClock(session.lastActivity) : "no activity";
      copy.append(name, meta);

      var count = document.createElement("span");
      count.className = "session-count";
      count.textContent = String(session.tabCount || 0);
      button.append(copy, count);
      els.sessionList.appendChild(button);
    });
  }

  function renderNetwork() {
    var query = els.networkFilterInput.value.trim().toLowerCase();
    var rows = state.networkRows.filter(function (row) {
      return !query || [row.method, row.status, row.url, row.type, row.time].join(" ").toLowerCase().indexOf(query) !== -1;
    });

    els.networkTableBody.replaceChildren();
    if (!rows.length) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 5;
      emptyCell.appendChild(emptyState("No network rows match the current filter."));
      emptyRow.appendChild(emptyCell);
      els.networkTableBody.appendChild(emptyRow);
      return;
    }

    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      tr.append(
        tableCell(badge(row.method || "GET", "method-badge")),
        tableCell(badge(String(row.status || "--"), "status-badge " + statusClass(row.status))),
        tableCell(row.url || "--"),
        tableCell(row.type || "--"),
        tableCell(row.time || "--")
      );
      els.networkTableBody.appendChild(tr);
    });
  }

  function renderLogs() {
    els.logList.replaceChildren();
    var rows = state.logs.filter(function (log) {
      return state.logFilter === "all" || log.level === state.logFilter;
    });

    if (!rows.length) {
      els.logList.appendChild(emptyState("No logs in this view."));
      return;
    }

    rows.forEach(function (log) {
      var row = document.createElement("div");
      row.className = "log-row";
      var time = document.createElement("div");
      time.className = "log-time";
      time.textContent = formatClock(log.time);
      var level = badge(log.level, "level-badge " + log.level);
      var message = document.createElement("div");
      message.className = "log-message";
      message.textContent = log.message;
      row.append(time, level, message);
      els.logList.appendChild(row);
    });
  }

  function renderHistory() {
    els.historyList.replaceChildren();
    els.historyCount.textContent = String(state.history.length);

    if (!state.history.length) {
      els.historyList.appendChild(emptyState("No command history yet."));
      return;
    }

    state.history.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "history-item";
      var command = document.createElement("div");
      command.className = "history-command";
      command.textContent = item.command;
      var status = document.createElement("div");
      status.className = "history-status " + (item.ok ? "ok" : "fail");
      status.textContent = item.ok ? "OK" : "FAIL";
      var time = document.createElement("div");
      time.className = "history-time";
      time.textContent = formatClock(item.time) + (item.duration ? " - " + item.duration + "ms" : "");
      row.append(command, status, time);
      els.historyList.appendChild(row);
    });
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll(".tab-button").forEach(function (button) {
      var active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".tab-panel").forEach(function (panel) {
      var active = panel.id === "panel-" + tab;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
  }

  function hydrateNetworkFromResult(result) {
    var data = result && result.data;
    var requests = data && (data.requests || data.entries || data.items);
    if (!Array.isArray(requests)) {
      return;
    }

    state.networkRows = requests.map(function (request) {
      var status = request.status || request.statusCode || request.responseStatus || "--";
      var time = request.durationMs || request.elapsedMs || request.time || request.timestampMs;
      return {
        method: request.method || "GET",
        status: status,
        url: request.url || request.requestUrl || request.href || "--",
        type: request.type || request.resourceType || request.initiatorType || "--",
        time: typeof time === "number" ? Math.round(time) + "ms" : String(time || "--")
      };
    });
    renderNetwork();
    setActiveTab("network");
  }

  function addLog(level, message) {
    state.logs.unshift({
      level: level,
      message: message,
      time: new Date().toISOString()
    });
    state.logs = state.logs.slice(0, 120);
    renderLogs();
  }

  function pushHistory(command, ok, duration) {
    state.history.unshift({
      command: command,
      ok: ok,
      duration: duration,
      time: new Date().toISOString()
    });
    state.history = state.history.slice(0, 40);
    renderHistory();
  }

  function setHistoryExpanded(expanded) {
    els.historyBlock.classList.toggle("is-expanded", expanded);
    els.toggleHistoryButton.setAttribute("aria-expanded", String(expanded));
    els.historyList.hidden = !expanded;
    els.historyList.tabIndex = expanded ? 0 : -1;
  }

  function setConnection(kind, label) {
    els.connectionPill.className = "status-pill " + kind;
    els.connectionPill.textContent = label;
  }

  function setValidation(message, type) {
    els.validationMessage.textContent = message;
    els.validationMessage.className = "validation-message" + (type ? " " + type : "");
  }

  function setButtonBusy(busy) {
    els.sendButton.disabled = busy;
    els.sendButton.setAttribute("aria-busy", String(busy));
  }

  function endpoint() {
    return els.endpointInput.value.trim().replace(/\/+$/, "");
  }

  function joinUrl(base, path) {
    return base.replace(/\/+$/, "") + path;
  }

  async function fetchJson(url, options) {
    var response = await fetch(url, options);
    var text = await response.text();
    var data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      var message = data && data.error && data.error.message ? data.error.message : response.status + " " + response.statusText;
      throw new Error(message);
    }
    return data;
  }

  function upsertSession(next) {
    var name = cleanSessionName(next.name);
    var current = normalizeSessions(state.sessions);
    var index = current.findIndex(function (session) {
      return session.name === name;
    });
    var merged = {
      name: name,
      tabCount: next.tabCount || 0,
      lastActivity: next.lastActivity || new Date().toISOString()
    };
    if (index >= 0) {
      current[index] = Object.assign({}, current[index], merged);
    } else {
      current.unshift(merged);
    }
    state.sessions = current;
  }

  function normalizeSessions(sessions) {
    if (!Array.isArray(sessions) || !sessions.length) {
      return [{ name: "default", tabCount: 0, lastActivity: new Date().toISOString() }];
    }
    return sessions.map(function (session) {
      if (typeof session === "string") {
        return { name: session, tabCount: 0, lastActivity: "" };
      }
      return {
        name: cleanSessionName(session.name),
        tabCount: Number(session.tabCount || session.tabs || 0),
        lastActivity: session.lastActivity || session.createdAt || ""
      };
    });
  }

  function cleanSessionName(value) {
    var cleaned = String(value || "default").trim();
    return cleaned || "default";
  }

  function formatUptime(seconds) {
    var total = Number(seconds) || 0;
    if (total < 60) return total + "s";
    var minutes = Math.floor(total / 60);
    if (minutes < 60) return minutes + "m";
    var hours = Math.floor(minutes / 60);
    return hours + "h " + (minutes % 60) + "m";
  }

  function byteLength(text) {
    if (window.TextEncoder) {
      return new TextEncoder().encode(text).length;
    }
    return unescape(encodeURIComponent(text)).length;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "--";
    if (bytes < 1024) return bytes + " B";
    var units = ["KB", "MB", "GB"];
    var value = bytes / 1024;
    for (var i = 0; i < units.length; i += 1) {
      if (value < 1024 || i === units.length - 1) {
        return value.toFixed(value >= 10 ? 1 : 2) + " " + units[i];
      }
      value /= 1024;
    }
    return bytes + " B";
  }

  function formatClock(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "--";
    }
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function tableCell(content) {
    var td = document.createElement("td");
    if (content instanceof Node) {
      td.appendChild(content);
    } else {
      td.textContent = String(content);
    }
    return td;
  }

  function badge(text, className) {
    var node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  }

  function statusClass(status) {
    var code = Number(status);
    if (code >= 500) return "error";
    if (code >= 300) return "warn";
    return "ok";
  }

  function emptyState(message) {
    var node = document.createElement("div");
    node.className = "empty-state";
    node.textContent = message;
    return node;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      showToast("Copied to clipboard.");
    } catch (error) {
      fallbackCopy(text);
      showToast("Copied to clipboard.");
    }
  }

  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(function () {
      els.toast.classList.remove("visible");
    }, 3200);
  }

  init();
})();
