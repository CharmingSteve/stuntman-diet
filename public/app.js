const $ = (selector) => document.querySelector(selector);
const loginPanel = $("#login-panel");
const appPanel = $("#app-panel");
const status = $("#status");
const tokenKey = "stuntman.accessToken";

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function randomString(length = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const digestBytes = await crypto.subtle.digest("SHA-256", bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digestBytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

let config;

async function loadConfig() {
  const response = await fetch("/auth/config");
  if (!response.ok) throw new Error("Could not load login configuration");
  config = await response.json();
}

async function startLogin() {
  if (!config?.domain || !config.clientId) throw new Error("Cognito is not configured");
  const verifier = randomString();
  const challenge = await digest(verifier);
  const state = randomString(20);
  sessionStorage.setItem("stuntman.pkce", verifier);
  sessionStorage.setItem("stuntman.oauthState", state);
  const url = new URL("/oauth2/authorize", config.domain.startsWith("https://") ? config.domain : `https://${config.domain}`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email",
    redirect_uri: config.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state
  });
  location.assign(url);
}

async function finishLogin() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return;
  const expectedState = sessionStorage.getItem("stuntman.oauthState");
  if (!expectedState || params.get("state") !== expectedState) throw new Error("Login state check failed");
  const verifier = sessionStorage.getItem("stuntman.pkce");
  if (!verifier) throw new Error("Login session expired; please try again");
  const domain = config.domain.startsWith("https://") ? config.domain : `https://${config.domain}`;
  const tokenResponse = await fetch(`${domain.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier
    })
  });
  if (!tokenResponse.ok) throw new Error("Could not complete sign-in");
  const tokens = await tokenResponse.json();
  if (typeof tokens.access_token !== "string") throw new Error("Sign-in did not return an access token");
  sessionStorage.setItem(tokenKey, tokens.access_token);
  sessionStorage.removeItem("stuntman.pkce");
  sessionStorage.removeItem("stuntman.oauthState");
  history.replaceState(null, "", location.pathname);
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem(tokenKey);
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers, signal: AbortSignal.timeout(30000) });
  if (response.status === 401) {
    sessionStorage.removeItem(tokenKey);
    show(appPanel, false);
    show(loginPanel, true);
    show($("#logout"), false);
    throw new Error("Your sign-in expired. Sign in again to continue.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  return body;
}

const pendingMutations = new Map();
let pendingChat;
let profile;
let historyRange = "";
let historyRequest = 0;
let trendRun;
let analyticsBusy = false;
let localLive = false;
let importBusy = false;
let importJob;
let reviewSaved = false;
let reviewRows = [];
const importStorageKey = "stuntman.lastImportJob";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function message(target, text, error = false) {
  target.textContent = text;
  target.classList.toggle("error", error);
  target.setAttribute("role", error ? "alert" : "status");
  target.setAttribute("aria-live", error ? "assertive" : "polite");
}

function errorText(error) {
  return error.name === "TimeoutError" || error.name === "AbortError"
    ? "The request timed out. Retry with the same inputs; the same mutation key will be reused."
    : error.message || "The request failed. Please retry.";
}

async function action(button, target, callback) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    await callback();
  } catch (error) {
    message(target, errorText(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function mutate(path, method, body = {}, key) {
  const payload = JSON.stringify(body);
  const identity = `${method} ${path} ${payload}`;
  const requestKey = key || pendingMutations.get(identity) || crypto.randomUUID();
  pendingMutations.set(identity, requestKey);
  const result = await api(path, {
    method,
    headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey },
    body: payload
  });
  pendingMutations.delete(identity);
  return result;
}

function addText(parent, tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function validDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

function assertZone(zone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    throw new Error("Enter a valid IANA timezone, for example Asia/Jerusalem.");
  }
}

function dateList(value) {
  const dates = value.split(/[,\s]+/).filter(Boolean);
  if (dates.some((day) => !validDay(day))) throw new Error("Use valid YYYY-MM-DD dates.");
  return [...new Set(dates)].sort();
}

function rangeValues(from, to, limit) {
  if (!validDay(from) || !validDay(to) || from > to) throw new Error("Choose a valid start and end date in order.");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (limit && days > limit) throw new Error(`Choose at most ${limit} calendar days at a time.`);
  return new URLSearchParams({ from, to }).toString();
}

function calendarDay(date, zone) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type) => parts.find((value) => value.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function offsetDay(day, amount) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "Unknown";
}

function table(parent, caption, columns) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("aria-label", caption);
  const element = document.createElement("table");
  addText(element, "caption", caption);
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  for (const title of columns) {
    const cell = addText(row, "th", title);
    cell.scope = "col";
  }
  head.append(row);
  const body = document.createElement("tbody");
  element.append(head, body);
  wrapper.append(element);
  parent.append(wrapper);
  return body;
}

function selectControl(parent, labelText, choices, value) {
  const label = addText(parent, "label", labelText);
  const select = document.createElement("select");
  for (const [key, text] of choices) {
    const option = addText(select, "option", text);
    option.value = key;
  }
  select.value = value;
  label.append(select);
  return select;
}

function dayControls(parent, day) {
  const form = document.createElement("form");
  form.className = "day-controls";
  const eligibility = selectControl(form, `Tracking for ${day.day}`, [["tracked", "Tracked"], ["untracked", "Not tracking"]], day.eligibility);
  const completeness = selectControl(form, `Completeness for ${day.day}`, [["missing", "Missing"], ["partial", "Partial"], ["complete", "Complete (user-confirmed)"]], day.completeness);
  const label = addText(form, "label", "Explicitly accept assumed 2,000 kcal burn for this tracked day", "check");
  const accept = document.createElement("input");
  accept.type = "checkbox";
  label.prepend(accept);
  const updateBurnChoice = () => {
    accept.disabled = eligibility.value !== "tracked" || completeness.value !== "complete" || day.burn_source === "recorded";
    if (accept.disabled) accept.checked = false;
  };
  eligibility.addEventListener("change", updateBurnChoice);
  completeness.addEventListener("change", updateBurnChoice);
  updateBurnChoice();
  const button = addText(form, "button", "Save day");
  button.type = "submit";
  const state = addText(form, "p", "", "status");
  state.setAttribute("role", "status");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(button, state, async () => {
      message(state, "Saving day…");
      await mutate(`/api/days/${encodeURIComponent(day.day)}`, "PUT", {
        eligibility: eligibility.value,
        completeness: completeness.value,
        ...(accept.checked ? { accept_default_burn: true } : {})
      });
      message($("#history-status"), `${day.day} saved. Analytics remain at their displayed snapshot until refreshed.`);
      await refreshHistory();
    });
  });
  parent.append(form);
}

async function refreshHistory() {
  const request = ++historyRequest;
  const selectedRange = historyRange;
  const root = $("#history");
  root.setAttribute("aria-busy", "true");
  message($("#history-status"), "Loading calendar days…");
  let result;
  try {
    const response = await api(`/api/history${selectedRange ? `?${selectedRange}` : ""}`);
    result = Array.isArray(response) ? response : response.days;
    if (!Array.isArray(result)) throw new Error("The history response was not a day list.");
  } finally {
    if (request === historyRequest) root.setAttribute("aria-busy", "false");
  }
  if (request !== historyRequest) return;
  root.replaceChildren();
  $("#history-window").textContent = selectedRange ? "SELECTED CALENDAR RANGE" : "LAST 30 CALENDAR DAYS";
  if (!result.length) addText(root, "p", "No calendar days returned for this range.");
  for (const day of result) {
    const details = document.createElement("details");
    details.className = "history-day";
    const eligible = day.eligibility === "tracked";
    const missing = day.completeness === "missing";
    const intake = day.entries.length ? day.entries.reduce((sum, item) => sum + item.calories, 0)
      : eligible && day.completeness === "complete" ? 0 : null;
    const state = !eligible ? "Not tracking" : missing ? "No log" : day.completeness;
    addText(details, "summary", `${day.day} · ${state}${intake === null ? "" : ` · ${number(intake)} kcal logged`}`);
    addText(details, "p", `Timezone: ${day.timezone} · Tracking: ${day.eligibility} · Completeness: ${day.completeness}`);
    if (day.entries.length) {
      const body = table(details, `Logged food on ${day.day}`, ["Time", "Food", "Calories (kcal)"]);
      for (const item of day.entries) {
        const row = document.createElement("tr");
        let time = item.occurred_at;
        try {
          time = new Intl.DateTimeFormat(undefined, { timeZone: day.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(item.occurred_at));
        } catch { /* Preserve the original timestamp if it cannot be formatted. */ }
        for (const text of [time, item.display_name, number(item.calories)]) addText(row, "td", text);
        body.append(row);
      }
      addText(details, "p", `Logged intake tally: ${number(intake)} kcal${day.completeness !== "complete" ? " (partial coverage, not a whole-day total)" : ""}.`);
    } else {
      addText(details, "p", !eligible ? "Not tracking — no intake or deficit is inferred."
        : day.completeness === "complete" ? "User-confirmed complete day with no food entries: 0 kcal logged."
        : "No log — intake is unknown, not zero.");
    }
    addText(details, "p", day.burn === null
      ? "Burn: unknown (2,000 kcal is only a proposal for tracked days)."
      : `Burn: ${number(day.burn)} kcal · ${day.burn_source === "assumed" ? "assumed, explicitly accepted" : day.burn_source === "recorded" ? "recorded" : "provenance unknown"}.`);
    const canShowNet = eligible && day.completeness === "complete" && day.burn !== null && ["recorded", "assumed"].includes(day.burn_source);
    addText(details, "p", `Whole-day net (intake − burn): ${canShowNet && day.net !== null ? `${number(day.net)} kcal` : "Unknown / not eligible"}.`);
    dayControls(details, day);
    root.append(details);
  }
  message($("#history-status"), `${result.length} calendar days loaded.`);
}

function selectedTrendRange() {
  return $("#trends-all").checked ? "" : rangeValues($("#trends-from").value, $("#trends-to").value);
}

function setTrendBusy(busy) {
  for (const id of ["refresh-trends", "refresh-analytics"]) $(`#${id}`).disabled = busy || analyticsBusy;
  $("#trends-range button").disabled = busy || analyticsBusy;
  $("#refresh-analytics").disabled = busy || analyticsBusy || localLive;
  $("#trends-all").disabled = busy || analyticsBusy;
  for (const id of ["trends-from", "trends-to"]) {
    $(`#${id}`).disabled = busy || analyticsBusy || $("#trends-all").checked;
  }
}

function renderTrends(result) {
  const root = $("#trends");
  root.replaceChildren();
  localLive = result.snapshot_id === "local-live";
  $("#refresh-analytics").textContent = localLive ? "Live local data — no snapshot refresh" : "Refresh analytics data";
  const snapshot = result.snapshot_at || (localLive ? "live local SQLite (no snapshot)" : "not provided");
  $("#snapshot").textContent = `Data as of: ${snapshot}${result.snapshot_id ? ` · Snapshot: ${result.snapshot_id}` : ""}`;
  if (!Array.isArray(result.rows)) throw new Error("The completed report did not include rows.");
  if (!result.rows.length) {
    addText(root, "p", "No report rows for this snapshot and date range.");
    return;
  }
  const columns = [
    ["kind", "Report"], ["period", "Period"], ["food", "Food / metric"],
    ["intake", "Logged intake (kcal)"], ["burn", "Burn (kcal)"], ["net", "Net (intake − burn)"],
    ["entries", "Entries"], ["value", "Metric value"], ["eligible", "Eligible days"],
    ["complete", "Complete"], ["partial", "Partial"], ["missing", "Missing"],
    ["excluded", "Excluded"], ["assumed", "Assumed burn"]
  ];
  const body = table(root, `Snapshot report · Data as of ${snapshot}`, columns.map(([, title]) => title));
  for (const item of result.rows) {
    const row = document.createElement("tr");
    for (const [key] of columns) {
      const value = item[key];
      addText(row, "td", value === null || value === undefined ? "—" : typeof value === "number" ? number(value) : String(value));
    }
    body.append(row);
  }
}

async function cancelTrendJob(run) {
  if (run.jobId && !run.cancelPromise) {
    run.cancelPromise = mutate(`/api/trends/${encodeURIComponent(run.jobId)}`, "DELETE")
      .catch((error) => {
        run.cancelPromise = undefined;
        throw error;
      });
  }
  return run.cancelPromise;
}

async function refreshTrends() {
  if (trendRun) return;
  const range = selectedTrendRange();
  const run = { cancelled: false };
  trendRun = run;
  setTrendBusy(true);
  show($("#cancel-trends"), true);
  $("#cancel-trends").disabled = false;
  $("#trends").setAttribute("aria-busy", "true");
  message($("#trends-status"), "Starting snapshot report…");
  const started = Date.now();
  try {
    let result = await api(`/api/trends${range ? `?${range}` : ""}`);
    const snapshot = { snapshot_at: result.snapshot_at, snapshot_id: result.snapshot_id };
    run.jobId = result.job_id;
    while (true) {
      if (run.cancelled) {
        await cancelTrendJob(run);
        message($("#trends-status"), "Query cancelled. Any displayed report is the previous snapshot.");
        return;
      }
      if (result.status === "complete") {
        renderTrends({ ...snapshot, ...result });
        run.finished = true;
        message($("#trends-status"), "Report complete. Coverage is shown with the snapshot totals.");
        return;
      }
      if (["failed", "cancelled"].includes(result.status)) {
        run.finished = true;
        throw new Error(result.error || `Query ${result.status}.`);
      }
      if (result.status !== "running" || !run.jobId) throw new Error("Unexpected query status or missing job ID.");
      if (Date.now() - started >= 120000) {
        await cancelTrendJob(run);
        throw new Error("The query exceeded two minutes and was cancelled. Run the report again.");
      }
      message($("#trends-status"), `Query running (${Math.floor((Date.now() - started) / 1000)}s). Data as of ${result.snapshot_at || snapshot.snapshot_at || "pending"}.`);
      await wait(2000);
      if (run.cancelled) continue;
      result = await api(`/api/trends/${encodeURIComponent(run.jobId)}`);
    }
  } catch (error) {
    if (run.jobId && !run.finished) {
      try { await cancelTrendJob(run); } catch {
        throw new Error(`${errorText(error)} The server query could not be cancelled; it may still be running.`);
      }
    }
    throw error;
  } finally {
    trendRun = undefined;
    setTrendBusy(false);
    show($("#cancel-trends"), false);
    $("#trends").setAttribute("aria-busy", "false");
  }
}

async function refreshAnalytics() {
  if (analyticsBusy || trendRun) return;
  if (localLive) {
    message($("#analytics-status"), "Local reports use live SQLite data. Run the report again; no snapshot refresh is needed.");
    return;
  }
  analyticsBusy = true;
  setTrendBusy(true);
  message($("#analytics-status"), "Starting or reusing an analytics snapshot refresh…");
  const started = Date.now();
  try {
    let result = await mutate("/api/analytics/refresh", "POST");
    const jobId = result.job_id;
    while (true) {
      if (result.status === "complete") {
        message($("#analytics-status"), `Analytics data refreshed${result.snapshot_at ? ` · Data as of ${result.snapshot_at}` : ""}. Loading the selected report…`);
        await refreshTrends();
        message($("#analytics-status"), "Analytics refresh finished. The selected report has been rerun; see its Data as of timestamp.");
        return;
      }
      if (result.status === "failed") throw new Error(result.error || "Analytics refresh failed. The last good snapshot remains available.");
      if (!["pending", "running"].includes(result.status) || !jobId) throw new Error("Unexpected refresh status or missing job ID.");
      if (Date.now() - started >= 600000) throw new Error("Still refreshing after ten minutes. The server job may continue; retry Refresh analytics data to reuse it.");
      message($("#analytics-status"), `Analytics refresh ${result.status} (${Math.floor((Date.now() - started) / 1000)}s)${result.snapshot_at ? ` · Requested snapshot: ${result.snapshot_at}` : ""}.`);
      await wait(5000);
      result = await api(`/api/analytics/refresh/${encodeURIComponent(jobId)}`);
    }
  } finally {
    analyticsBusy = false;
    setTrendBusy(Boolean(trendRun));
  }
}

async function refreshProfile() {
  profile = await api("/api/profile");
  $("#timezone").value = profile.timezone;
  $("#holidays").value = (profile.holidays || []).join("\n");
  for (const checkbox of document.querySelectorAll('#weekdays input')) {
    checkbox.checked = (profile.non_tracking_weekdays || [5, 6]).includes(Number(checkbox.value));
  }
  const today = calendarDay(new Date(), profile.timezone);
  for (const prefix of ["history", "trends"]) {
    if (!$(`#${prefix}-from`).value) $(`#${prefix}-from`).value = offsetDay(today, -29);
    if (!$(`#${prefix}-to`).value) $(`#${prefix}-to`).value = today;
  }
  message($("#profile-status"), "Settings loaded.");
}

const exampleSource = {
  conversation_id: "stable-conversation-id",
  messages: [
    { id: "meal-1", timestamp: "2026-10-21T12:30:00+03:00", timezone: "Asia/Jerusalem", kind: "meal", display_name: "Cottage cheese", calories: 320, quantity: 250, unit: "g" },
    { id: "fix-1", timestamp: "2026-10-21T12:35:00+03:00", kind: "correction", target_id: "meal-1", action: "replace", display_name: "Cottage cheese (corrected portion)", calories: 160 },
    { id: "burn-1", timestamp: "2026-10-21T23:00:00+03:00", kind: "burn", total: 2400 },
    { id: "summary-1", timestamp: "2026-10-21T23:01:00+03:00", kind: "summary", total: 160 },
    { id: "metric-1", timestamp: "2026-10-21T07:00:00+03:00", kind: "metric", metric: "glucose", value: 90, unit: "mg/dL" }
  ]
};
$("#import-example").textContent = JSON.stringify(exampleSource, null, 2);

function canonicalSource(source, filename) {
  const fail = (detail) => { throw new Error(`${filename}: ${detail}`); };
  if (!source || typeof source !== "object" || typeof source.conversation_id !== "string" || !source.conversation_id.trim() || !Array.isArray(source.messages)) {
    fail("expected a conversation_id and messages array. See canonical JSON format help.");
  }
  const messages = source.messages.map((item, index) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim() ||
        typeof item.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item.timestamp) ||
        !validDay(item.timestamp.slice(0, 10)) || !Number.isFinite(Date.parse(item.timestamp))) {
      fail(`message ${index + 1} needs a stable id and an ISO timestamp with an explicit offset.`);
    }
    const fields = {
      meal: ["display_name", "calories", "quantity", "unit"],
      summary: ["total"],
      correction: ["target_id", "action", "display_name", "calories"],
      metric: ["metric", "value", "unit"],
      burn: ["total"]
    };
    if (!Object.hasOwn(fields, item.kind)) fail(`message ${index + 1} has an unsupported kind.`);
    const required = item.kind === "meal" ? ["display_name", "calories"]
      : item.kind === "correction" ? ["target_id", "action", ...(item.action === "replace" ? ["display_name", "calories"] : [])]
      : item.kind === "metric" ? ["metric", "value", "unit"] : ["total"];
    for (const field of required) {
      if (item[field] === undefined || item[field] === null || item[field] === "") fail(`message ${index + 1} is missing ${field}.`);
    }
    if (item.kind === "correction" && !["void", "replace"].includes(item.action)) fail(`message ${index + 1} has an invalid correction action.`);
    const clean = { id: item.id, timestamp: item.timestamp, kind: item.kind };
    if (item.timezone !== undefined) {
      if (typeof item.timezone !== "string" || !item.timezone.trim()) fail(`message ${index + 1} has an invalid timezone.`);
      assertZone(item.timezone);
      clean.timezone = item.timezone;
    }
    for (const field of fields[item.kind]) {
      if (item[field] === undefined) continue;
      if (["calories", "quantity", "total", "value"].includes(field)) {
        if (typeof item[field] !== "number" || !Number.isFinite(item[field]) || item[field] < 0) fail(`message ${index + 1}: ${field} must be a non-negative number.`);
      } else if (typeof item[field] !== "string" || !item[field].trim()) {
        fail(`message ${index + 1}: ${field} must be a non-empty string.`);
      }
      clean[field] = item[field];
    }
    return clean;
  });
  return { conversation_id: source.conversation_id, messages };
}

function browserSources(sourceFile, filename) {
  const fail = (detail) => { throw new Error(`${filename}: ${detail}`); };
  const conversations = Array.isArray(sourceFile) ? sourceFile : [sourceFile];
  if (!conversations.length) fail("the export contains no conversations.");
  return conversations.map((source) => {
    if (!source || typeof source !== "object") fail("expected a conversation object or array.");
    const conversationId = source.conversation_id ?? source.id;
    if (typeof conversationId !== "string" || !conversationId.trim()) fail("each conversation needs a stable id or conversation_id.");
    let messages = source.messages;
    if (source.mapping && typeof source.mapping === "object") {
      let current = source.current_node;
      if (typeof current !== "string" || !current) fail("a ChatGPT mapping needs current_node to select its active branch.");
      messages = [];
      const visited = new Set();
      while (current) {
        if (visited.has(current)) fail("the conversation mapping contains a cycle.");
        visited.add(current);
        const node = Object.hasOwn(source.mapping, current) ? source.mapping[current] : null;
        if (!node || typeof node !== "object") fail("the active branch references a missing node.");
        if (node.message) {
          messages.push({
            id: node.message.id,
            role: node.message.author?.role,
            create_time: node.message.create_time,
            content: node.message.content
          });
        }
        if (node.parent != null && typeof node.parent !== "string") fail("the active branch has an invalid parent.");
        current = node.parent;
      }
      messages.reverse();
    }
    if (!Array.isArray(messages)) fail("expected a messages array or ChatGPT mapping.");
    const assistantMessages = messages.filter((item) => item?.role === "assistant").map((item) => {
      const content = typeof item.content === "string" ? item.content
        : Array.isArray(item.content?.parts) ? item.content.parts.filter((part) => typeof part === "string").join("\n") : null;
      if (content === null) fail("assistant messages need text content or a content.parts array.");
      return {
        ...(typeof item.id === "string" ? { id: item.id } : {}),
        role: "assistant",
        ...(typeof item.timestamp === "string" ? { timestamp: item.timestamp } : {}),
        ...(typeof item.create_time === "number" ? { create_time: item.create_time } : {}),
        content
      };
    });
    if (!assistantMessages.length) fail("no assistant messages were found on the selected branch.");
    return { conversation_id: conversationId, messages: assistantMessages };
  });
}

function rememberImport(id) {
  importJob = id;
  try { localStorage.setItem(importStorageKey, id); } catch { /* Import still works when browser storage is unavailable. */ }
  show($("#resume-import"), true);
}

function reportImport(result) {
  const root = $("#import-report");
  root.replaceChildren();
  const report = result.report || result;
  addText(root, "h3", "Import reconciliation");
  for (const key of ["inserted", "duplicate", "corrected", "skipped", "unresolved", "failed"]) {
    addText(root, "p", `${key}: ${number(report[key])}`);
  }
  if (Array.isArray(report.reconciliation) && report.reconciliation.length) {
    const pre = addText(root, "pre", JSON.stringify(report.reconciliation, null, 2), "response");
    pre.setAttribute("aria-label", "Source versus ledger reconciliation");
  } else {
    addText(root, "p", "No daily reconciliation details were returned.");
  }
}

function invalidateReview() {
  reviewSaved = false;
  $("#import-confirmed").checked = false;
  show($("#import-confirm"), false);
}

function renderImportPreview(result) {
  const root = $("#import-preview");
  root.replaceChildren();
  $("#import-report").replaceChildren();
  invalidateReview();
  $("#import-reviewed").checked = false;
  $("#import-complete").value = "";
  $("#import-tracked").value = "";
  addText(root, "h3", `Preview · Job ${importJob}`);
  const issues = Array.isArray(result.issues) ? result.issues : [];
  addText(root, "p", issues.length ? `${issues.length} import issues need review.` : "No batch-level issues reported. Check every record before confirming.");
  const list = document.createElement("ul");
  for (const issue of issues) addText(list, "li", String(issue));
  root.append(list);
  if (!Array.isArray(result.records)) throw new Error("The import preview did not include records.");
  const records = $("#import-records");
  records.replaceChildren();
  reviewRows = [];
  const body = table(records, "Review canonical source records", ["Source / kind", "Record", "Issue", "Decision", "Verified day", "Timezone override"]);
  for (const record of result.records) {
    const row = document.createElement("tr");
    addText(row, "td", `${record.source_id} · ${record.kind}`);
    addText(row, "td", `${record.display_name || record.kind}${record.calories === undefined ? "" : ` · ${number(record.calories)} kcal`}`);
    const needsReview = Boolean(record.issue) || $("#import-format").value === "browser";
    addText(row, "td", record.issue || (needsReview ? "Explicit table-row review required" : "None reported"));
    const decision = selectControl(addText(row, "td", ""), `Decision for ${record.source_id}`, [
      ["", "Choose a decision"], ["include", "Include (reviewed)"], ["skip", "Skip"]
    ], needsReview ? "" : "include");
    const dayLabel = addText(addText(row, "td", ""), "label", `Day for ${record.source_id}`);
    const day = document.createElement("input");
    day.type = "date";
    day.value = validDay(record.day) ? record.day : "";
    dayLabel.append(day);
    const zoneLabel = addText(addText(row, "td", ""), "label", `Timezone for ${record.source_id}`);
    const zone = document.createElement("input");
    zone.type = "text";
    zone.maxLength = 100;
    zone.value = record.timezone || profile?.timezone || "Asia/Jerusalem";
    zone.placeholder = "Verified IANA timezone";
    zoneLabel.append(zone);
    reviewRows.push({ sourceId: record.source_id, decision, day, zone });
    body.append(row);
  }
  show($("#import-review"), true);
}

async function watchImport(result) {
  const started = Date.now();
  while (true) {
    if (["preview", "reviewed"].includes(result.status)) {
      renderImportPreview(result);
      message($("#import-status"), "Preview ready. No records have been committed by this preview.");
      return;
    }
    if (["complete", "completed", "failed", "partial"].includes(result.status)) {
      reportImport(result);
      message($("#import-status"), `Import ${result.status}. Review counts and daily reconciliation; unresolved or failed records are not complete.`, result.status === "failed");
      await refreshHistory().catch((error) => message($("#history-status"), errorText(error), true));
      return;
    }
    if (!["pending", "running", "confirmed", "importing"].includes(result.status)) throw new Error("Unexpected import status. Resume the job to check progress.");
    if (Date.now() - started >= 180000) throw new Error("Import is still running after three minutes. Use Resume last import; committed source groups are not imported twice.");
    const report = result.report || result;
    message($("#import-status"), `Import ${result.status} (${Math.floor((Date.now() - started) / 1000)}s) · Job ${importJob} · Inserted ${number(report.inserted)}, duplicate ${number(report.duplicate)}, unresolved ${number(report.unresolved)}, failed ${number(report.failed)}. Processing the next bounded chunk; you can resume after leaving this page.`);
    await wait(200);
    result = await mutate(`/api/imports/${encodeURIComponent(importJob)}/confirm`, "POST");
  }
}

async function importAction(button, callback) {
  if (importBusy) return;
  importBusy = true;
  const controls = "#import-form input, #import-form select, #import-form button, #import-review input, #import-review select, #import-review textarea, #import-review button, #import-confirm input, #import-confirm button, #resume-import";
  for (const element of document.querySelectorAll(controls)) element.disabled = true;
  try {
    await callback();
  } catch (error) {
    message($("#import-status"), errorText(error), true);
  } finally {
    importBusy = false;
    for (const element of document.querySelectorAll(controls)) element.disabled = false;
    if (button) button.disabled = false;
  }
}

$("#download-example").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(exampleSource, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "stuntman-canonical-example.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("#import-form").addEventListener("submit", (event) => {
  event.preventDefault();
  importAction(event.submitter, async () => {
    const files = [...$("#import-files").files];
    const browser = $("#import-format").value === "browser";
    if (!files.length) throw new Error("Select at least one supported JSON file.");
    if (files.reduce((size, file) => size + file.size, 0) > 5 * 1024 * 1024) throw new Error("Combined file size must not exceed 5 MB.");
    if (browser && !$("#browser-import-ack").checked) throw new Error("Acknowledge the table-only extraction limitations before uploading browser exports.");
    const sources = [];
    message($("#import-status"), browser ? "Validating browser JSON and selecting assistant messages from the active branch…" : "Validating canonical JSON files…");
    for (const file of files) {
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error(`${file.name}: not valid JSON. Raw HTML and arbitrary browser formats are not supported. See conversion help.`); }
      sources.push(...(browser ? browserSources(parsed, file.name) : [canonicalSource(parsed, file.name)]));
    }
    invalidateReview();
    show($("#import-review"), false);
    const result = await mutate("/api/imports/preview", "POST", { sources });
    if (typeof result.job_id !== "string" || !result.job_id) throw new Error("Import preview returned no job ID.");
    rememberImport(result.job_id);
    renderImportPreview(result);
    message($("#import-status"), "Preview ready. Review uncertainties, then save your review and explicitly confirm.");
  });
});

$("#import-format").addEventListener("change", (event) => {
  const browser = event.target.value === "browser";
  show($("#browser-import-warning"), browser);
  $("#browser-import-ack").required = browser;
  $("#browser-import-ack").checked = false;
});

$("#import-review").addEventListener("input", invalidateReview);
$("#import-review").addEventListener("change", invalidateReview);
$("#import-review").addEventListener("submit", (event) => {
  event.preventDefault();
  importAction(event.submitter, async () => {
    if (!$("#import-reviewed").checked) throw new Error("Confirm that you reviewed the issues and records.");
    const resolutions = reviewRows.map(({ sourceId, decision, day, zone }) => {
      if (!decision.value) throw new Error(`Choose Include or Skip for ${sourceId}.`);
      if (decision.value === "skip") return { source_id: sourceId, action: "skip" };
      if (!validDay(day.value)) throw new Error(`Verify the date for ${sourceId}, or skip the record.`);
      const timezone = zone.value.trim();
      if (!timezone) throw new Error(`Verify the timezone for ${sourceId}, or skip the record.`);
      assertZone(timezone);
      return { source_id: sourceId, action: "include", day: day.value, timezone };
    });
    message($("#import-status"), "Saving reviewed resolutions…");
    await mutate(`/api/imports/${encodeURIComponent(importJob)}/review`, "PUT", {
      resolutions,
      complete_days: dateList($("#import-complete").value),
      tracked_days: dateList($("#import-tracked").value)
    });
    reviewSaved = true;
    show($("#import-confirm"), true);
    message($("#import-status"), "Review saved. Explicit confirmation is required to commit records.");
  });
});

$("#import-confirm").addEventListener("submit", (event) => {
  event.preventDefault();
  importAction(event.submitter, async () => {
    if (!reviewSaved || !$("#import-confirmed").checked) throw new Error("Save the review and explicitly confirm first.");
    message($("#import-status"), "Confirming import… Retry with the same review if the response is interrupted.");
    const result = await mutate(`/api/imports/${encodeURIComponent(importJob)}/confirm`, "POST");
    show($("#import-confirm"), false);
    show($("#import-review"), false);
    await watchImport(result);
  });
});

$("#resume-import").addEventListener("click", (event) => {
  importAction(event.currentTarget, async () => {
    let id = importJob;
    if (!id) {
      try { id = localStorage.getItem(importStorageKey); } catch { /* Storage may be unavailable. */ }
    }
    if (!id) throw new Error("No saved import job is available in this browser.");
    importJob = id;
    show($("#import-review"), false);
    show($("#import-confirm"), false);
    message($("#import-status"), `Resuming job ${id}…`);
    await watchImport(await api(`/api/imports/${encodeURIComponent(id)}`));
  });
});

try { show($("#resume-import"), Boolean(localStorage.getItem(importStorageKey))); } catch { /* Optional resume storage. */ }

async function initialize() {
  try {
    await loadConfig();
    await finishLogin();
    const authenticated = Boolean(sessionStorage.getItem(tokenKey));
    show(loginPanel, !authenticated);
    show(appPanel, authenticated);
    show($("#logout"), authenticated);
    if (authenticated) {
      await refreshProfile().catch((error) => message($("#profile-status"), errorText(error), true));
      if (!$("#trends-from").value) {
        const today = calendarDay(new Date(), "Asia/Jerusalem");
        for (const prefix of ["history", "trends"]) {
          $(`#${prefix}-from`).value = offsetDay(today, -29);
          $(`#${prefix}-to`).value = today;
        }
      }
      await Promise.all([
        refreshHistory().catch((error) => message($("#history-status"), errorText(error), true)),
        refreshTrends().catch((error) => message($("#trends-status"), errorText(error), true))
      ]);
    }
  } catch (error) {
    setStatus(error.message, true);
    show(loginPanel, true);
  }
}

$("#login").addEventListener("click", () => startLogin().catch((error) => setStatus(error.message, true)));
$("#logout").addEventListener("click", () => {
  sessionStorage.removeItem(tokenKey);
  if (!config?.domain || !config.clientId) {
    location.reload();
    return;
  }
  const domain = config.domain.startsWith("https://") ? config.domain : `https://${config.domain}`;
  const url = new URL("/logout", domain);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.redirectUri
  });
  location.assign(url);
});
$("#log-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(event.submitter, $("#log-status"), async () => {
    const text = $("#message").value.trim();
    const image = $("#image").files[0];
    if (!text && !image) throw new Error("Enter a food, burn, or health reading, or attach a food photo.");
    if (image && (!["image/jpeg", "image/png", "image/webp"].includes(image.type) || image.size > 5 * 1024 * 1024)) {
      throw new Error("Choose a JPEG, PNG, or WebP image no larger than 5 MB.");
    }
    message($("#log-status"), "Processing…");
    show($("#response"), false);
    if (!pendingChat || pendingChat.text !== text || pendingChat.image !== image) {
      pendingChat = { text, image, clientTime: new Date().toISOString(), key: crypto.randomUUID() };
    }
    const request = pendingChat;
    const headers = { "Idempotency-Key": request.key };
    let body;
    if (image) {
      body = new FormData();
      body.set("text", text || "Please identify the food in this image.");
      body.set("client_time", request.clientTime);
      body.set("image", image);
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ text, client_time: request.clientTime });
    }
    const result = await api("/api/chat", { method: "POST", headers, body });
    pendingChat = undefined;
    $("#response").textContent = result.message || "No response";
    show($("#response"), true);
    if ($("#message").value.trim() === text) $("#message").value = "";
    if ($("#image").files[0] === image) $("#image").value = "";
    message($("#log-status"), "Saved. Analytics may lag this entry until their snapshot is refreshed.");
    await refreshHistory().catch((error) => message($("#history-status"), errorText(error), true));
  });
});
$("#profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(event.submitter, $("#profile-status"), async () => {
    const timezone = $("#timezone").value.trim();
    assertZone(timezone);
    const holidays = dateList($("#holidays").value);
    const nonTracking = [...document.querySelectorAll("#weekdays input:checked")].map((element) => Number(element.value));
    message($("#profile-status"), "Saving settings…");
    await mutate("/api/profile", "PUT", { timezone, holidays, non_tracking_weekdays: nonTracking });
    profile = { timezone, holidays, non_tracking_weekdays: nonTracking };
    message($("#profile-status"), "Settings saved. Historical day assignments are unchanged.");
    await refreshHistory().catch((error) => message($("#history-status"), errorText(error), true));
  });
});
$("#add-holidays").addEventListener("click", (event) => {
  action(event.currentTarget, $("#profile-status"), async () => {
    const from = $("#holiday-from").value;
    const to = $("#holiday-to").value;
    rangeValues(from, to, 366);
    const days = dateList($("#holidays").value);
    for (let day = from; day <= to; day = offsetDay(day, 1)) days.push(day);
    $("#holidays").value = [...new Set(days)].sort().join("\n");
    message($("#profile-status"), "Holiday range added. Save tracking settings to apply it.");
  });
});
$("#history-range").addEventListener("submit", (event) => {
  event.preventDefault();
  action(event.submitter, $("#history-status"), async () => {
    historyRange = rangeValues($("#history-from").value, $("#history-to").value, 93);
    await refreshHistory();
  });
});
$("#history-default").addEventListener("click", (event) => {
  action(event.currentTarget, $("#history-status"), async () => {
    historyRange = "";
    const today = calendarDay(new Date(), profile?.timezone || "Asia/Jerusalem");
    $("#history-from").value = offsetDay(today, -29);
    $("#history-to").value = today;
    await refreshHistory();
  });
});
$("#refresh-history").addEventListener("click", (event) => {
  action(event.currentTarget, $("#history-status"), refreshHistory);
});
$("#trends-all").addEventListener("change", (event) => {
  for (const id of ["trends-from", "trends-to"]) $(`#${id}`).disabled = event.target.checked;
});
$("#trends-range").addEventListener("submit", (event) => {
  event.preventDefault();
  refreshTrends().catch((error) => message($("#trends-status"), errorText(error), true));
});
$("#refresh-trends").addEventListener("click", () => {
  refreshTrends().catch((error) => message($("#trends-status"), errorText(error), true));
});
$("#refresh-analytics").addEventListener("click", () => {
  refreshAnalytics().catch((error) => message($("#analytics-status"), errorText(error), true));
});
$("#cancel-trends").addEventListener("click", (event) => {
  const run = trendRun;
  if (!run) return;
  run.cancelled = true;
  action(event.currentTarget, $("#trends-status"), async () => {
    message($("#trends-status"), "Cancelling query…");
    await cancelTrendJob(run);
    if (run.jobId) message($("#trends-status"), "Query cancellation requested.");
  });
});

initialize();
