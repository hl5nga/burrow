import type ko from "./ko";

/** Every leaf widened to `string` (ko's `as const` makes them literal types)
 * and every level optional, so a translation can differ from ko's exact
 * text and a module can be only partially translated. */
type Loose<T> = T extends string ? string : { [K in keyof T]?: Loose<T[K]> };

/** Partial on purpose — `t()` falls back to `ko` for any key missing here,
 * so this can be filled in module by module without ever breaking the app.
 * See docs/i18n-plan.md for the migration order. */
const en: Loose<typeof ko> = {
  launcher: {
    title: "Burrow",
    subtitle: "Choose a connection",
    online: "🌐 Online",
    offline: "🌐 Offline",
    offlineHint: "No internet connection",
    localTerminal: "Local terminal",
    thisMac: "This Mac",
    ssh: "SSH",
    connect: "Connect",
    open: "Open",
    autoOpen: "Open automatically",
    autoOpenHint: "Skips this list and opens this one straight away next time",
    newConnection: "＋ New connection",
    noProfiles: "No SSH profiles yet. Register a new connection below.",
  },
  language: {
    label: "Language",
    system: "Follow system setting",
    ko: "한국어",
    en: "English",
  },
  about: {
    title: "Burrow",
    tagline:
      "A terminal for developers who SSH into a home dev machine and work alongside AI agents.",
    stack: "Tauri · Rust · xterm.js",
    close: "Close",
  },
  confirmClose: {
    title: "Close Burrow?",
    body1: "Every open local terminal session will end.",
    body2:
      "Remote tmux sessions over SSH stay on the server and pick up where they left off next time you connect.",
    body3:
      'If a profile has a "VPN disconnect command" set, any VPN with no tabs left using it will be turned off too.',
    cancel: "Cancel",
    close: "Close",
  },
  commandManager: {
    listTitle: "Registered commands",
    addNew: "＋ New",
    guardrails: "Guardrails",
    guardrailsTitle: "Rules for risky-command guardrails",
    keybindings: "Shortcuts",
    emptyList: "No commands registered yet. Create your first one on the right.",
    checking: "Checking…",
    online: "Online",
    offline: "Offline · {{reason}}",
    proxyUnknown: "Can't check ahead of time — routed through a proxy",
    connect: "Connect",
    connectTitle: "Connect to {{host}}",
    newTitle: "New command",
    untitled: "Command",
    sshProfileHint:
      "SSH profile — connecting applies the remote zsh hooks, and commands run remotely are tracked separately.",
    shellHint: "Shell command — runs directly from the ⌘K palette and the frequent-commands panel.",
    type: "Type",
    typeShell: "Shell command",
    typeSshProfile: "SSH profile",
    fields: {
      name: { label: "Name", placeholder: "e.g. Deploy, home laptop" },
      command: { label: "Command", placeholder: "e.g. npm run deploy" },
      sshHost: {
        label: "SSH host",
        placeholder: "e.g. user@home-laptop.tailnet.ts.net",
        hint: 'Can\'t connect while the remote laptop is asleep. Turn on System Settings › Battery › Options › "Wake for network access" there, or run caffeinate -s.',
      },
      tmuxSession: {
        label: "tmux session",
        placeholder: "Leave blank to connect without tmux",
        hint: "Connecting automatically reattaches to a tmux session with this name",
      },
      vpnPreConnect: {
        label: "Pre-connect VPN command",
        placeholder: 'e.g. scutil --nc start "Work VPN"',
        hint: 'Only if set — runs on this Mac when the host is unreachable. e.g. tailscale up · scutil --nc start "Work VPN" · wg-quick up home (commands needing sudo won\'t work)',
      },
      vpnPostDisconnect: {
        label: "VPN disconnect command",
        placeholder: 'e.g. scutil --nc stop "Work VPN"',
        hint: "Leave blank and Burrow never turns the VPN off itself. Fill it in and it runs automatically once no tab is using this VPN anymore (closing a tab or quitting Burrow).",
      },
      description: { label: "Description" },
    },
    vpnAutofill: "Fill in from the connect command",
    vpnAutofillFailed:
      "Couldn't work out the opposite command automatically from this connect command — enter it yourself",
    save: "Save",
    register: "Register",
    close: "Close",
    delete: "Delete",
    deleteConfirm: "Confirm delete",
    homeNetworks: {
      label: "Home networks (skip VPN)",
      gateway: "Gateway {{mac}}",
      remove: "Remove",
      add: "＋ Mark this network as home",
      unknownNetwork: "Can't identify this network's gateway (offline, or routed through a VPN)",
      alreadyAdded: "This network is already registered",
      homeName: "Home ({{gateway}})",
      hintWithNetworks:
        "On these networks, connections skip the VPN step; on any other network the VPN command always runs first. (Identified by gateway address — macOS doesn't expose the Wi-Fi network name to apps.)",
      hintEmpty:
        "Without any registered, the VPN command only runs when the host is unreachable. An outside network that happens to share the same address range (e.g. 192.168.1.x) could be misdetected, so registering one at home is recommended.",
    },
    transport: {
      label: "Transport",
      auto: "Automatic (Mosh if the remote has mosh-server)",
      ssh: "SSH",
      mosh: "Mosh",
      hint: "Mosh keeps the session alive across Wi-Fi changes or brief drops. This Mac needs mosh too (brew install mosh).",
    },
    saveFailed: "Couldn't save: {{error}}",
    saved: "Saved '{{name}}'",
    deleted: "Deleted '{{name}}'",
    tmuxTag: "tmux · {{session}}",
  },
};

export default en;
