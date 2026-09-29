import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/fonts.css";
import appIcon from "./assets/icon.png";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { SessionContext } from "./terminal/session";
import { CommandPalette } from "./ui/palette";
import { FrequentPanel } from "./ui/frequent-panel";
import { CommandManager } from "./ui/command-manager";
import { TabManager, type Connection } from "./ui/tabs";
import { connectProfile } from "./ui/connect";
import { VpnChip } from "./ui/vpn-chip";
import { ResourceMonitor } from "./ui/resource-chip";
import { AgentMonitor } from "./ui/agents";
import { GuardrailPrompt } from "./ui/guardrail-prompt";
import { GuardrailManager } from "./ui/guardrail-manager";
import { Keybindings } from "./ui/keybindings";
import { FileBrowser } from "./ui/file-browser";
import { Launcher, resolveAutoOpen, type LauncherEntry } from "./ui/launcher";
import { NetworkChip } from "./ui/network-chip";
import { TextSizeChip } from "./ui/text-chip";
import { loadTextSettings } from "./ui/text-settings";
import { ThemeChip } from "./ui/theme-chip";
import { loadTheme } from "./ui/theme-settings";
import { showAbout } from "./ui/about";
import { confirmCloseWindow } from "./ui/confirm-close";
import "./styles/launcher.css";
import "./styles/files.css";
import "highlight.js/styles/github-dark.css";
import "./styles/agents.css";
import type { StoredCommand } from "./ui/command-validation";
import "./styles/palette.css";
import "./styles/frequent-panel.css";
import "./styles/command-manager.css";
import "./styles/blocks.css";
import "./styles/hud.css";
import { showStoreRecoveries } from "./ui/toast";

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <header class="titlebar" data-tauri-drag-region>
    <img class="brand-icon" src="${appIcon}" alt="" data-tauri-drag-region />
    <div class="tabs" data-tauri-drag-region></div>
  </header>
  <div class="workspace">
    <section class="term-body"><div class="res-mini"></div></section>
  </div>
  <footer class="statusbar">
    <div class="seg host"><span class="ico">◆</span> <span class="host-name">local</span></div>
    <div class="divider"></div>
    <div class="seg cwd"></div>
    <div class="seg branch" hidden><span class="ico">⎇</span> <span class="branch-name"></span></div>
    <div class="seg transport" hidden></div>
    <button type="button" class="seg agents-status" hidden title="에이전트 대시보드 (⌘⇧A)"></button>
  </footer>
`;

app.querySelector<HTMLElement>(".statusbar .cwd")!.addEventListener("click", () => files.toggle());

const status = {
  host: app.querySelector<HTMLElement>(".statusbar .host-name")!,
  cwd: app.querySelector<HTMLElement>(".statusbar .cwd")!,
  branch: app.querySelector<HTMLElement>(".statusbar .branch")!,
  branchName: app.querySelector<HTMLElement>(".statusbar .branch-name")!,
  transport: app.querySelector<HTMLElement>(".statusbar .transport")!,
  agentsStatus: app.querySelector<HTMLButtonElement>(".statusbar .agents-status")!,
};

const CONNECTION_STATE: Record<Connection["state"], string> = {
  connecting: "연결 중…",
  connected: "",
  reconnecting: "재연결 중…",
  offline: "오프라인",
  stopped: "끊김",
};

function showConnection(connection: Connection | undefined) {
  status.transport.hidden = !connection;
  if (!connection) return;
  const name = connection.transport === "mosh" ? "Mosh" : "SSH";
  const state = CONNECTION_STATE[connection.state];
  status.transport.textContent = state ? `${name} · ${state}` : name;
  status.transport.dataset.state = connection.state;
  status.transport.title =
    connection.transport === "mosh"
      ? "Mosh: 네트워크가 바뀌어도 세션이 유지됩니다"
      : "SSH: 끊기면 자동으로 다시 연결합니다";
}

function showContext(context: SessionContext | undefined) {
  status.host.textContent = context?.host ?? "local";
  // Before the shell's first prompt (or for an SSH tab whose tmux pane was
  // already busy when it attached, so no hook event has arrived at all) cwd
  // is still unknown — show a placeholder so the button stays visible and
  // clickable instead of disappearing.
  status.cwd.textContent = context?.cwd || "폴더 보기";
  // Dim only when the button truly can't do anything (a tab the user ssh'd
  // into by hand, outside Burrow's SSH profiles) — not just because cwd
  // hasn't arrived yet, since the file browser can still fetch it itself now.
  status.cwd.classList.toggle("placeholder", !!tabs.activeTarget()?.foreignShell);
  status.branch.hidden = !context?.branch;
  status.branchName.textContent = context?.branch ?? "";
}

const tabs = new TabManager(
  app.querySelector<HTMLElement>(".tabs")!,
  app.querySelector<HTMLElement>(".term-body")!,
  {
    onActiveContext: (context) => {
      showContext(context);
      files.follow();
      resources.activeChanged();
      void frequent.refresh();
      updateAgentStatusBar();
    },
    onHookEvent: (event) => {
      // stats_record went out on "exec"; by the next prompt the counts include it.
      if (event.type === "prompt") void frequent.refresh();
    },
    onActiveConnection: (connection) => {
      showConnection(connection);
      resources.activeChanged();
      updateAgentStatusBar();
    },
    confirmCloseLastTab: async () => {
      if (!(await confirmCloseWindow())) return false;
      // remove() goes on to call onLastTabClosed() -> window.close(), which
      // would otherwise hit the same native CloseRequested interception
      // (lib.rs's ConfirmedExit) and ask a second, redundant time.
      await invoke("confirm_exit").catch(() => {});
      return true;
    },
    onLastTabClosed: () => getCurrentWindow().close(),
  },
);
const activeSession = () => tabs.activeSession();

/**
 * A persistent, always-visible summary in the status bar: each agent Burrow
 * currently tracks for the active tab (every tmux pane if it's an SSH+tmux
 * connection, or the tab's own single agent otherwise), name + colored dot.
 * Clicking it opens the same detail view as ⌘⇧A.
 */
function updateAgentStatusBar() {
  const items = agents.summaryForActiveTab();
  status.agentsStatus.hidden = items.length === 0;
  status.agentsStatus.replaceChildren(
    ...items.map(({ label, state }) => {
      const chip = document.createElement("span");
      chip.className = `agent-chip ${state}`;
      chip.append(document.createElement("span"), document.createTextNode(label));
      chip.firstElementChild!.className = "agent-chip-dot";
      chip.firstElementChild!.textContent = "●";
      return chip;
    }),
  );
}
status.agentsStatus.addEventListener("click", () => agents.toggle());
// Dev builds: lets scripts/devctl read terminal state (e.g. `devctl screen`).
const devBag: Record<string, unknown> = { tabs };
if (import.meta.env.DEV) Object.assign(window, { __burrow: devBag });

const vpn = new VpnChip(app.querySelector<HTMLElement>(".res-mini")!);
new NetworkChip(app.querySelector<HTMLElement>(".res-mini")!);
new TextSizeChip(app.querySelector<HTMLElement>(".res-mini")!, (fontSize, lineHeight) =>
  tabs.applyTextSettings(fontSize, lineHeight),
);
new ThemeChip(app.querySelector<HTMLElement>(".res-mini")!, (themeId) => tabs.applyTheme(themeId));
const resources = new ResourceMonitor(app.querySelector<HTMLElement>(".res-mini")!, () =>
  tabs.resourceTargets(),
);
const connect = (profile: StoredCommand) => void connectProfile(tabs, profile, vpn);
const guardrails = new GuardrailManager(() => tabs.activeTarget());
const manager = new CommandManager(
  connect,
  () => void guardrails.open(() => activeSession()?.focus()),
  // `keys` is created below; this only runs on a click, long after.
  () => keys.open(() => activeSession()?.focus()),
);
const palette = new CommandPalette(
  activeSession,
  (id) => manager.open(id, () => activeSession()?.focus()),
  connect,
);
const files = new FileBrowser(app.querySelector<HTMLElement>(".workspace")!, () => ({
  target: tabs.activeTarget(),
  session: activeSession(),
}));
const agents = new AgentMonitor(() => tabs.sshTabs(), updateAgentStatusBar);
tabs.observe(agents);
tabs.observe(new GuardrailPrompt());
const frequent = new FrequentPanel(app.querySelector<HTMLElement>(".workspace")!, activeSession);

const inTerminal = (e: Event) =>
  !!app.querySelector(".term-body")?.contains(e.target as Node) &&
  !(e.target as HTMLElement).closest?.(".res-mini");
const keys = new Keybindings({
  altScreen: () => activeSession()?.term.buffer.active.type === "alternate",
  inTerminal,
});
const focusTerminal = () => activeSession()?.focus();
keys.register({
  id: "toggle-command-palette",
  label: "커맨드 팔레트",
  run: () => palette.toggle(),
});
keys.register({
  id: "toggle-frequent-panel",
  label: "자주 쓰는 명령어 패널",
  run: () => frequent.toggle(),
});
keys.register({
  id: "toggle-agent-dashboard",
  label: "에이전트 대시보드",
  run: () => agents.toggle(),
});
keys.register({
  id: "open-command-manager",
  label: "명령어·SSH 프로필 관리",
  run: () => {
    if (manager.isOpen) manager.close();
    else void manager.open(undefined, focusTerminal);
  },
});
keys.register({
  id: "open-keybindings",
  label: "단축키 설정",
  run: () => (keys.isOpen ? keys.close() : keys.open(focusTerminal)),
});
keys.register({ id: "toggle-file-browser", label: "파일 탐색 패널", run: () => files.toggle() });
keys.register({ id: "new-tab", label: "새 탭", run: () => void tabs.newTab() });
keys.register({ id: "close-tab", label: "탭 닫기", run: () => tabs.close() });
keys.register({ id: "next-tab", label: "다음 탭", run: () => tabs.selectRelative(1) });
keys.register({ id: "previous-tab", label: "이전 탭", run: () => tabs.selectRelative(-1) });
for (let n = 1; n <= 9; n++) {
  keys.register({ id: `select-tab-${n}`, label: `${n}번째 탭`, run: () => tabs.select(n - 1) });
}
keys.register({
  id: "copy",
  label: "선택 영역 복사",
  // Text fields in panels keep their native copy; in the terminal, no
  // selection means nothing happens (interrupting is Ctrl-C on macOS).
  run: (e) => {
    const session = activeSession();
    if (!session || !inTerminal(e)) return false;
    void session.copySelection();
  },
});
keys.addToggle(
  "마우스로 선택하면 바로 복사",
  () => tabs.copyOnSelect,
  (on) => {
    tabs.copyOnSelect = on;
    void invoke<Record<string, unknown>>("store_get", { kind: "config" }).then((config) =>
      invoke("store_put", { kind: "config", value: { ...config, copyOnSelect: on } }),
    );
  },
);
void keys.load();

void invoke<{ copyOnSelect?: boolean }>("store_get", { kind: "config" }).then((c) => {
  tabs.copyOnSelect = !!c.copyOnSelect;
});
void listen("network-changed", () => tabs.networkChanged());
showStoreRecoveries();

/**
 * The connection list's "＋ 새 연결" button: the same SSH-profile form ⌘,
 * opens (pre-filled as a new profile). Resolves once the user connects
 * something from it — any profile, not just the one just created — or
 * undefined if they close the form without connecting.
 */
function openNewSshProfile(): Promise<LauncherEntry | undefined> {
  return new Promise((resolve) => {
    let profile: StoredCommand | undefined;
    let attempted: Promise<unknown> | undefined;
    // Overrides the shared `connect` for just this manager session, so we can
    // await the actual connection attempt instead of the fire-and-forget
    // `connect` wrapper every other caller uses.
    manager.connectOverride = (p) => {
      profile = p;
      attempted = connectProfile(tabs, p, vpn);
    };
    void manager.open({ type: "ssh-profile" }, () => {
      void (async () => {
        try {
          await attempted;
        } catch {
          // connectProfile already reports its own failures via toast.
        }
        // Only a tab that actually opened counts as "handled"; a failed
        // attempt (offline host, cancelled hook install, …) returns to the list.
        resolve(profile && tabs.activeSession() ? { kind: "ssh", profile } : undefined);
      })();
    });
  });
}

async function openEntry(entry: LauncherEntry) {
  if (entry.kind === "local") await tabs.newTab();
  else await connectProfile(tabs, entry.profile, vpn);
}

/**
 * Startup: a configured auto-open target skips the connection list entirely
 * (T25); otherwise the list is shown and whichever entry the user picks opens.
 * Nothing to cancel back to yet, so the list isn't dismissible here.
 */
async function start() {
  // Before any tab opens, so the very first one is sized correctly and
  // doesn't flash at the default before jumping to the saved size.
  await loadTextSettings();
  await loadTheme();
  const auto = await resolveAutoOpen();
  if (auto) {
    await openEntry(auto);
  } else {
    let entry: LauncherEntry | undefined;
    while (!entry) entry = await new Launcher(app, openNewSshProfile).open();
    await openEntry(entry);
  }
  await frequent.init();
}
void start();

/** Menu bar → Burrow → 연결 목록 보기: the same list, dismissible this time. */
async function viewStartup() {
  const entry = await new Launcher(app, openNewSshProfile, true).open();
  if (entry) await openEntry(entry);
}
void listen("menu-view-startup", () => void viewStartup());
void listen("menu-about", () => void showAbout());
void listen("confirm-quit", () => void handleConfirmQuit());

/** The Rust side already prevented the actual close; this decides whether it may proceed. */
async function handleConfirmQuit() {
  if (!(await confirmCloseWindow())) return;
  // This path (red button, ⌘Q, Dock Quit, menu 종료) skips each tab's own
  // teardown, so the per-tab VPN check in tabs.close() never runs — do it
  // once here instead, for every VPN any open tab currently has engaged.
  await tabs.disconnectAllVpns();
  await invoke("confirm_exit").catch(() => {});
  await getCurrentWindow().close();
}

Object.assign(devBag, { showAbout, viewStartup, handleConfirmQuit });
