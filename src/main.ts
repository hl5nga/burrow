import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/fonts.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
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
  </footer>
`;

const status = {
  host: app.querySelector<HTMLElement>(".statusbar .host-name")!,
  cwd: app.querySelector<HTMLElement>(".statusbar .cwd")!,
  branch: app.querySelector<HTMLElement>(".statusbar .branch")!,
  branchName: app.querySelector<HTMLElement>(".statusbar .branch-name")!,
  transport: app.querySelector<HTMLElement>(".statusbar .transport")!,
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
  status.cwd.textContent = context?.cwd ?? "";
  status.branch.hidden = !context?.branch;
  status.branchName.textContent = context?.branch ?? "";
}

const tabs = new TabManager(
  app.querySelector<HTMLElement>(".tabs")!,
  app.querySelector<HTMLElement>(".term-body")!,
  {
    onActiveContext: (context) => {
      showContext(context);
      resources.activeChanged();
      void frequent.refresh();
    },
    onHookEvent: (event) => {
      // stats_record went out on "exec"; by the next prompt the counts include it.
      if (event.type === "prompt") void frequent.refresh();
    },
    onActiveConnection: (connection) => {
      showConnection(connection);
      resources.activeChanged();
    },
    onLastTabClosed: () => getCurrentWindow().close(),
  },
);
const activeSession = () => tabs.activeSession();
// Dev builds: lets scripts/devctl read terminal state (e.g. `devctl screen`).
if (import.meta.env.DEV) Object.assign(window, { __burrow: { tabs } });

const vpn = new VpnChip(app.querySelector<HTMLElement>(".res-mini")!);
const resources = new ResourceMonitor(app.querySelector<HTMLElement>(".res-mini")!, () =>
  tabs.resourceTargets(),
);
const connect = (profile: StoredCommand) => void connectProfile(tabs, profile, vpn);
const guardrails = new GuardrailManager(() => tabs.activeTarget());
const manager = new CommandManager(
  connect,
  () => void guardrails.open(() => activeSession()?.focus()),
);
const palette = new CommandPalette(
  activeSession,
  (id) => manager.open(id, () => activeSession()?.focus()),
  connect,
);
const agents = new AgentMonitor(() => tabs.sshTabs());
tabs.observe(agents);
tabs.observe(new GuardrailPrompt());
const frequent = new FrequentPanel(app.querySelector<HTMLElement>(".workspace")!, activeSession);

// Matched on physical keys so shortcuts still work with a Korean input source.
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.shiftKey) {
      if (e.code === "KeyA") {
        handled();
        agents.toggle();
      } else if (e.code === "BracketRight") {
        handled();
        tabs.selectRelative(1);
      } else if (e.code === "BracketLeft") {
        handled();
        tabs.selectRelative(-1);
      }
      return;
    }
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      handled();
      tabs.select(Number(digit[1]) - 1);
      return;
    }
    switch (e.code) {
      case "KeyK":
        handled();
        palette.toggle();
        break;
      case "Comma":
        handled();
        if (manager.isOpen) manager.close();
        else void manager.open(undefined, () => activeSession()?.focus());
        break;
      case "KeyJ":
        handled();
        frequent.toggle();
        break;
      case "KeyT":
        handled();
        void tabs.newTab();
        break;
      case "KeyW":
        handled();
        tabs.close();
        break;
    }
  },
  true,
);

void tabs.newTab().then(() => frequent.init());
void listen("network-changed", () => tabs.networkChanged());
showStoreRecoveries();
