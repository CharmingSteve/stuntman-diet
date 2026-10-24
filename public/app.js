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
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    sessionStorage.removeItem(tokenKey);
    show(appPanel, false);
    show(loginPanel, true);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function addText(parent, tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

async function refreshHistory() {
  const result = await api("/api/history");
  const root = $("#history");
  root.replaceChildren();
  for (const day of result.days) {
    const details = document.createElement("details");
    details.className = "history-day";
    const summary = document.createElement("summary");
    const intake = day.entries.reduce((sum, item) => sum + item.calories, 0);
    summary.textContent = `${day.day} · ${Math.round(intake)} kcal intake · ${day.burn === null ? "burn not set" : `${Math.round(day.burn)} kcal burned`}`;
    details.append(summary);
    if (day.entries.length) {
      const list = document.createElement("ul");
      for (const item of day.entries) addText(list, "li", `${new Date(item.occurred_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — ${item.display_name}: ${Math.round(item.calories)} kcal`);
      details.append(list);
    } else {
      addText(details, "p", "No entries");
    }
    root.append(details);
  }
}

async function refreshTrends() {
  const trends = await api("/api/trends");
  const root = $("#trends");
  root.replaceChildren();
  addText(root, "p", `Last 30-day net (burn − intake): ${Math.round(trends.monthlyDeficit)} kcal`);
  addText(root, "h3", "Weekly intake and burn");
  if (!trends.weekly.length) addText(root, "p", "Log a few days to see weekly trends.");
  for (const week of trends.weekly) addText(root, "p", `${week.week}: ${Math.round(week.intake)} kcal intake, ${Math.round(week.burn)} kcal burned, ${Math.round(week.net)} kcal net`);
  addText(root, "h3", "Most logged foods (30 days)");
  for (const food of trends.topFoods) addText(root, "p", `${food.food}: ${Math.round(food.calories)} kcal across ${food.entries} entries`);
  if (trends.glucose.length) {
    addText(root, "h3", "Glucose readings");
    for (const reading of trends.glucose) addText(root, "p", `${reading.day}: ${Number(reading.value).toFixed(1)}`);
  }
}

async function refreshProfile() {
  const profile = await api("/api/profile");
  $("#timezone").value = profile.timezone;
}

async function initialize() {
  try {
    await loadConfig();
    await finishLogin();
    const authenticated = Boolean(sessionStorage.getItem(tokenKey));
    show(loginPanel, !authenticated);
    show(appPanel, authenticated);
    show($("#logout"), authenticated);
    if (authenticated) {
      await Promise.all([refreshProfile(), refreshHistory(), refreshTrends()]);
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
$("#log-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#message").value.trim();
  const image = $("#image").files[0];
  if (!text && !image) {
    setStatus("Enter a food or burn entry, or attach a food photo.", true);
    return;
  }
  setStatus("Processing...");
  $("#response").classList.add("hidden");
  try {
    const form = new FormData();
    form.set("text", text || "Please identify the food in this image.");
    form.set("client_time", new Date().toISOString());
    if (image) form.set("image", image);
    const result = await api("/api/chat", { method: "POST", body: form });
    $("#response").textContent = result.message || "No response";
    $("#response").classList.remove("hidden");
    $("#message").value = "";
    $("#image").value = "";
    setStatus("Saved.");
    await Promise.all([refreshHistory(), refreshTrends()]);
  } catch (error) {
    setStatus(error.message, true);
  }
});
$("#timezone").addEventListener("change", async (event) => {
  try {
    await api("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: event.target.value.trim() })
    });
    setStatus("Timezone saved. Past days are unchanged.");
  } catch (error) {
    setStatus(error.message, true);
    await refreshProfile();
  }
});
$("#refresh-history").addEventListener("click", () => refreshHistory().catch((error) => setStatus(error.message, true)));
$("#refresh-trends").addEventListener("click", () => refreshTrends().catch((error) => setStatus(error.message, true)));

initialize();
