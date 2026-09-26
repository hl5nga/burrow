export type AgentState = "unknown" | "working" | "waiting" | "done" | "error";

/** One tool's entry in agent-patterns.json (regex sources). */
export interface ToolPatterns {
  label: string;
  commands: string[];
  detect: string[];
  waitingApproval: string[];
  working: string[];
  error: string[];
  idle: string[];
}

interface CompiledTool {
  id: string;
  label: string;
  commands: Set<string>;
  detect: RegExp[];
  waiting: RegExp[];
  working: RegExp[];
  error: RegExp[];
  idle: RegExp[];
}

/** Only the bottom of the screen: prompts and status lines live there, and
 * older output (an error the agent already recovered from) shouldn't count. */
export const SCAN_LINES = 20;

function compile(sources: string[]): RegExp[] {
  return sources.flatMap((source) => {
    try {
      // "m" so ^/$ anchor to lines of the screen text.
      return [new RegExp(source, "m")];
    } catch {
      return []; // A broken user pattern must not break the other ones.
    }
  });
}

/** Screen-text heuristics for AI CLIs; every phrase comes from the patterns file. */
export class AgentClassifier {
  private readonly tools: CompiledTool[];

  constructor(tools: Record<string, ToolPatterns>) {
    this.tools = Object.entries(tools).map(([id, t]) => ({
      id,
      label: t.label || id,
      commands: new Set(t.commands ?? []),
      detect: compile(t.detect ?? []),
      waiting: compile(t.waitingApproval ?? []),
      working: compile(t.working ?? []),
      error: compile(t.error ?? []),
      idle: compile(t.idle ?? []),
    }));
  }

  label(toolId: string): string {
    return this.tools.find((t) => t.id === toolId)?.label ?? toolId;
  }

  /** The tool a shell command starts, e.g. `claude --resume` → claude-code. */
  toolForCommand(cmd: string): string | undefined {
    // Skip env assignments and wrappers like `FOO=1 npx claude`.
    const words = cmd
      .trim()
      .split(/\s+/)
      .filter((w) => !/^\w+=/.test(w));
    const first = words[0] === "npx" || words[0] === "exec" ? words[1] : words[0];
    const name = first?.split("/").pop();
    return name ? this.tools.find((t) => t.commands.has(name))?.id : undefined;
  }

  detect(screen: string): string | undefined {
    return this.tools.find((t) => t.detect.some((re) => re.test(screen)))?.id;
  }

  /**
   * The lowest matching line wins: it's the newest thing on screen, so an
   * approval prompt the user already answered (still visible above) doesn't
   * outrank what came after it. On the same line, approval beats working beats
   * error. An idle footer below an old prompt or error means the turn ended,
   * but never overrides "working": some tools keep that footer up while busy.
   */
  classify(toolId: string, screen: string): AgentState {
    const t = this.tools.find((x) => x.id === toolId);
    if (!t) return "unknown";
    const hit = (list: RegExp[], line: string) => list.some((re) => re.test(line));
    const lines = screen.split("\n");
    let idleBelow = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (hit(t.waiting, line)) return idleBelow ? "done" : "waiting";
      if (hit(t.working, line)) return "working";
      if (hit(t.error, line)) return idleBelow ? "done" : "error";
      if (hit(t.idle, line)) idleBelow = true;
    }
    return idleBelow ? "done" : "unknown";
  }
}
