import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/fonts.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openTerminalSession, type TerminalSession } from "./terminal/session";
import { CommandPalette } from "./ui/palette";
import { FrequentPanel } from "./ui/frequent-panel";
import "./styles/palette.css";
import "./styles/frequent-panel.css";
import { showStoreRecoveries } from "./ui/toast";

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <header class="titlebar" data-tauri-drag-region>
    <div class="tabs" data-tauri-drag-region>
      <div class="tab active"><span class="dot"></span><span class="tab-label">로컬</span></div>
    </div>
  </header>
  <div class="workspace">
    <section class="term-body"><div class="term-host"></div></section>
  </div>
  <footer class="statusbar">
    <div class="seg host"><span class="ico">◆</span> local</div>
    <div class="divider"></div>
    <div class="seg cwd">~</div>
  </footer>
`;

const host = app.querySelector<HTMLElement>(".term-host")!;

const cwdLabel = app.querySelector<HTMLElement>(".statusbar .cwd")!;

let session: TerminalSession | undefined;
const palette = new CommandPalette(() => session);
const frequent = new FrequentPanel(app.querySelector<HTMLElement>(".workspace")!, () => session);

// Matched on the physical key so the shortcut still works with a Korean input source.
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.code === "KeyK") {
      e.preventDefault();
      e.stopPropagation();
      palette.toggle();
    } else if (e.code === "KeyJ") {
      e.preventDefault();
      e.stopPropagation();
      frequent.toggle();
    }
  },
  true,
);

openTerminalSession(host, {
  onExit: () => getCurrentWindow().close(),
  onContext: ({ cwd }) => {
    cwdLabel.textContent = cwd;
    void frequent.refresh();
  },
  onHookEvent: (event) => {
    // stats_record went out on "exec"; by the next prompt the counts include it.
    if (event.type === "prompt") void frequent.refresh();
  },
})
  .then((s) => {
    session = s;
    void frequent.init();
  })
  .catch((err) => {
    host.textContent = `터미널을 시작하지 못했습니다: ${err}`;
  });

showStoreRecoveries();
