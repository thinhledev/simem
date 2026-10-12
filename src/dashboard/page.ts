// The dashboard is one self-contained page (no external scripts, fonts, or
// requests) so it works offline and under a strict Content-Security-Policy.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mixai memory</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e4e4df;
  --accent: #2f6f5e; --accent-soft: #e3efeb; --warn: #9a5b00; --bad: #a33a2b;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #141413; --panel: #1d1d1b; --text: #ecece8; --muted: #9a9a93; --line: #2e2e2b;
    --accent: #7cc4ad; --accent-soft: #1f302b; --warn: #e0a54a; --bad: #e07a6a; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 20px 24px 8px; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
h1 small { color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 14px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
main { max-width: 1100px; margin: 0 auto; padding: 8px 24px 48px; display: grid; gap: 16px; }
select, input, button, textarea { font: inherit; color: inherit; }
select, input[type=search] { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.tile, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }
.scroll { overflow-x: auto; }
.tile .value { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.tile .label { color: var(--muted); font-size: 13px; }
.tile .note { color: var(--muted); font-size: 12px; margin-top: 4px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
td.num { text-align: right; white-space: nowrap; }
.bar { height: 6px; background: var(--accent-soft); border-radius: 3px; overflow: hidden; margin-top: 4px; }
.bar > span { display: block; height: 100%; background: var(--accent); }
.tag { display: inline-block; font-size: 12px; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); margin-right: 4px; }
.tag.muted { background: transparent; border: 1px solid var(--line); color: var(--muted); }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
.toolbar input[type=search] { flex: 1 1 220px; }
.item { padding: 10px 0; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: 1fr auto; gap: 8px; }
.item:last-child { border-bottom: 0; }
.item .text { white-space: pre-wrap; overflow-wrap: anywhere; }
.item textarea { width: 100%; min-height: 64px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
.actions { display: flex; gap: 6px; align-items: flex-start; }
button { background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--panel); }
.check { display: flex; gap: 8px; padding: 4px 0; }
.check .icon { width: 18px; flex: none; }
.ok { color: var(--accent); } .warn { color: var(--warn); } .fail { color: var(--bad); } .info { color: var(--muted); }
.muted { color: var(--muted); }
.empty { color: var(--muted); padding: 12px 0; }
@media (max-width: 600px) { header, main { padding-left: 16px; padding-right: 16px; } .item { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>mixai <small id="project">loading…</small></h1>
  <div class="toolbar" style="margin:0">
    <select id="projectSelect" aria-label="Project"></select>
    <select id="range" aria-label="Period">
      <option value="1">Today</option><option value="7">7 days</option><option value="30" selected>30 days</option><option value="0">All time</option>
    </select>
  </div>
</header>
<main>
  <section class="tiles" id="tiles"></section>
  <section class="grid2">
    <div class="panel"><h2>Saved by mixai</h2><div id="savings"></div></div>
    <div class="panel"><h2>What filled the context</h2><div id="xray"></div></div>
  </section>
  <section class="panel"><h2>Provider usage (from your agents' transcripts)</h2><div id="usage"></div></section>
  <section class="panel">
    <h2>Project memory</h2>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search memory… (e.g. why did we pick Postgres)">
      <select id="status"><option value="active">Active</option><option value="archived">Forgotten</option></select>
    </div>
    <div id="items"></div>
  </section>
  <section class="grid2">
    <div class="panel"><h2>Your preferences (all projects)</h2><div id="global"></div></div>
    <div class="panel"><h2>Setup</h2><div id="checks"></div></div>
  </section>
</main>
<script>
const base = location.pathname.replace(/\\/$/, "");
let project = new URLSearchParams(location.search).get("project") || "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n || 0));
const LABELS = { exec: "Command output filtered", "code-read": "code_read instead of whole files", "code-search": "code_search instead of reading files", "read-guard": "Outline instead of a large read", "reread-guard": "Unchanged re-reads skipped", disclosure: "Memory previews", compaction: "Old summaries merged", "consolidation-cap": "Consolidation prompt capped", "rollup-cap": "Rollup prompt capped", "inject-dedupe": "Memory not re-injected" };
async function api(path, options = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const response = await fetch(base + path + (project ? sep + "project=" + encodeURIComponent(project) : ""), { ...options, headers: { "content-type": "application/json" } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}
function bars(rows, value, label, note) {
  if (!rows.length) return '<div class="empty">Nothing yet.</div>';
  const max = Math.max(...rows.map(value), 1);
  return "<table>" + rows.map((r) => '<tr><td>' + esc(label(r)) + (note ? ' <span class="muted">' + esc(note(r)) + '</span>' : '') + '<div class="bar"><span style="width:' + (100 * value(r) / max).toFixed(1) + '%"></span></div></td><td class="num">~' + fmt(value(r)) + '</td></tr>').join("") + "</table>";
}
async function loadSummary() {
  const days = Number($("range").value);
  const { project: p, stats } = await api("/api/summary?days=" + days);
  $("project").textContent = p.name + " · " + (p.mode === "global" ? "shared across agents & accounts" : "in-repo store");
  const u = stats.usageTotal;
  $("tiles").innerHTML = [
    ["~" + fmt(stats.savedTokens), "tokens kept out of context", "measured from characters"],
    ["~" + fmt(stats.compoundedTokens), "re-sent tokens avoided", "estimate: × " + stats.typicalLaterTurns + " later turns"],
    [fmt(u.input + u.cacheRead + u.cacheWrite + u.output), "tokens sent to providers", fmt(u.cacheRead) + " of them cheaper cache reads · " + u.sessions + " sessions"],
    [String(stats.memory.items), "memories", stats.memory.sessions + " sessions captured"],
  ].map(([v, l, n]) => '<div class="tile"><div class="value">' + esc(v) + '</div><div class="label">' + esc(l) + '</div><div class="note">' + esc(n) + '</div></div>').join("");
  $("savings").innerHTML = bars(stats.savings, (r) => r.tokens, (r) => LABELS[r.mechanism] || r.mechanism, (r) => r.measured ? r.events + "×" : "estimate");
  $("xray").innerHTML = bars(stats.xray, (r) => r.tokens, (r) => r.type, (r) => r.calls + " calls");
  $("usage").innerHTML = stats.usage.length
    ? "<div class=scroll><table><tr><th>Agent</th><th>Sessions</th><th class=num>Input</th><th class=num>Cache read</th><th class=num>Cache write</th><th class=num>Output</th></tr>" +
      stats.usage.map((r) => "<tr><td>" + esc(r.key) + "</td><td>" + r.sessions + "</td><td class=num>" + fmt(r.input) + "</td><td class=num>" + fmt(r.cacheRead) + "</td><td class=num>" + fmt(r.cacheWrite) + "</td><td class=num>" + fmt(r.output) + "</td></tr>").join("") + "</table></div>"
    : '<div class="empty">No sessions captured yet. Run <code>mixai sync</code>.</div>';
}
async function loadItems() {
  const q = $("q").value.trim();
  const { items } = await api("/api/memory?" + (q ? "q=" + encodeURIComponent(q) : "status=" + $("status").value));
  const archived = $("status").value === "archived" && !q;
  $("items").innerHTML = items.length ? items.map((it) =>
    '<div class="item" data-id="' + it.id + '"><div><div class="text">' + esc(it.text) + '</div><div>' +
    (it.category ? '<span class="tag">' + esc(it.category) + '</span>' : '') +
    (it.importance ? '<span class="tag muted">importance ' + it.importance + '</span>' : '') +
    (it.origin ? '<span class="tag muted">' + esc(it.origin) + '</span>' : '') + '</div></div><div class="actions">' +
    (archived ? '<button data-act="restore">Restore</button>' : '<button data-act="edit">Edit</button><button data-act="promote" title="Apply to all projects">All projects</button><button data-act="forget">Forget</button>') +
    '</div></div>').join("") : '<div class="empty">' + (q ? "Nothing matches." : "No memories here yet.") + '</div>';
}
async function loadGlobal() {
  const { items } = await api("/api/global");
  $("global").innerHTML = items.length ? items.map((it) => '<div class="item"><div class="text">' + esc(it.text) + '</div><div class="actions"><button data-global="' + it.id + '">Remove</button></div></div>').join("") : '<div class="empty">None yet. Use “All projects” on a memory to add one.</div>';
}
async function loadChecks() {
  const { checks } = await api("/api/checks");
  const icon = { ok: "✓", warn: "!", fail: "✗", info: "·" };
  $("checks").innerHTML = checks.map((c) => '<div class="check"><span class="icon ' + c.level + '">' + icon[c.level] + '</span><span><b>' + esc(c.area) + '</b> ' + esc(c.message) + '</span></div>').join("");
}
async function loadProjects() {
  const { current, projects } = await api("/api/projects");
  if (!project) project = current;
  $("projectSelect").innerHTML = projects.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === project ? " selected" : "") + ">" + esc(p.name) + "</option>").join("");
}
$("items").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const row = button.closest(".item");
  const id = row.dataset.id;
  const act = button.dataset.act;
  if (act === "edit") {
    const text = row.querySelector(".text");
    text.outerHTML = '<textarea>' + esc(text.textContent) + '</textarea>';
    button.textContent = "Save"; button.dataset.act = "save"; button.classList.add("primary");
    return;
  }
  if (act === "save") await api("/api/memory/" + id, { method: "PATCH", body: JSON.stringify({ text: row.querySelector("textarea").value }) });
  else await api("/api/memory/" + id + "/" + act, { method: "POST", body: "{}" });
  await Promise.all([loadItems(), loadGlobal()]);
});
$("global").addEventListener("click", async (event) => {
  const id = event.target.closest("button")?.dataset.global;
  if (!id) return;
  await api("/api/global/" + id + "/demote", { method: "POST", body: "{}" });
  loadGlobal();
});
let timer;
$("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(loadItems, 250); });
$("status").addEventListener("change", loadItems);
$("range").addEventListener("change", loadSummary);
$("projectSelect").addEventListener("change", (event) => { project = event.target.value; refresh(); });
async function refresh() {
  try { await Promise.all([loadSummary(), loadItems(), loadGlobal(), loadChecks()]); }
  catch (error) { $("project").textContent = "error: " + error.message; }
}
loadProjects().then(refresh);
</script>
</body>
</html>
`;
