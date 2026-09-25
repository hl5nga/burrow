import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/fonts.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openTerminalSession } from "./terminal/session";
import { showStoreRecoveries } from "./ui/toast";

const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <header class="titlebar" data-tauri-drag-region>
    <div class="tabs" data-tauri-drag-region>
      <div class="tab active"><span class="dot"></span><span class="tab-label">로컬</span></div>
    </div>
  </header>
  <section class="term-body"><div class="term-host"></div></section>
  <footer class="statusbar">
    <div class="seg host"><span class="ico">◆</span> local</div>
    <div class="divider"></div>
    <div class="seg cwd">~</div>
  </footer>
`;

const host = app.querySelector<HTMLElement>(".term-host")!;

const cwdLabel = app.querySelector<HTMLElement>(".statusbar .cwd")!;

openTerminalSession(host, {
  onExit: () => getCurrentWindow().close(),
  onContext: ({ cwd }) => {
    cwdLabel.textContent = cwd;
  },
}).catch((err) => {
  host.textContent = `터미널을 시작하지 못했습니다: ${err}`;
});

showStoreRecoveries();
