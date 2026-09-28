import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyCommand,
  normalizeCommand,
  suggestVpnDisconnect,
  validateCommand,
} from "./command-validation.ts";

const ssh = (sshHost: string, tmuxSession: string | null = null) => ({
  ...emptyCommand("ssh-profile"),
  name: "집 노트북",
  sshHost,
  tmuxSession,
});

test("shell commands need a command line", () => {
  assert.deepEqual(validateCommand({ ...emptyCommand(), command: "npm test" }), {});
  assert.ok(validateCommand({ ...emptyCommand(), name: "이름만" }).command);
  assert.ok(validateCommand({ ...emptyCommand(), command: "   " }).command);
});

test("valid ssh hosts are accepted", () => {
  for (const host of [
    "home-laptop",
    "home-laptop.tailnet.ts.net",
    "felix@home-laptop.tailnet.ts.net",
    "deploy@10.0.0.12",
    "server:2222",
    "me@my_alias",
  ]) {
    assert.deepEqual(validateCommand(ssh(host)), {}, host);
  }
});

test("hosts that ssh could read as options or that are malformed are rejected", () => {
  for (const host of [
    "-oProxyCommand=touch /tmp/pwned",
    "-J evil",
    "user@-oProxyCommand=x",
    "host name",
    "host;rm -rf ~",
    "$(whoami)@host",
    "host:port",
    "",
  ]) {
    assert.ok(validateCommand(ssh(host)).sshHost, host);
  }
});

test("tmux session names are restricted", () => {
  assert.deepEqual(validateCommand(ssh("h", "burrow_main-1")), {});
  for (const name of ["with.dot", "with:colon", "has space", "x".repeat(65)]) {
    assert.ok(validateCommand(ssh("h", name)).tmuxSession, name);
  }
});

test("normalizing drops fields that do not apply to the type", () => {
  const shell = normalizeCommand({
    ...emptyCommand(),
    command: "  npm test  ",
    sshHost: "leftover",
    tmuxSession: "x",
    transport: "mosh",
  });
  assert.equal(shell.command, "npm test");
  assert.equal(shell.sshHost, null);
  assert.equal(shell.transport, "auto");

  const profile = normalizeCommand({ ...ssh(" host ", "  "), command: "leftover" });
  assert.equal(profile.command, "");
  assert.equal(profile.sshHost, "host");
  assert.equal(profile.tmuxSession, null);
});

test("known VPN connect commands get a matching disconnect suggestion", () => {
  assert.equal(suggestVpnDisconnect('scutil --nc start "회사 VPN"'), 'scutil --nc stop "회사 VPN"');
  assert.equal(suggestVpnDisconnect("scutil --nc start HomeVPN"), "scutil --nc stop HomeVPN");
  assert.equal(suggestVpnDisconnect("tailscale up"), "tailscale down");
  assert.equal(suggestVpnDisconnect("tailscale up --accept-routes"), "tailscale down");
  assert.equal(suggestVpnDisconnect("  tailscale up  "), "tailscale down");
});

test("unrecognized VPN commands get no suggestion, never a guess", () => {
  assert.equal(suggestVpnDisconnect("wg-quick up home"), null);
  assert.equal(suggestVpnDisconnect("./my-vpn-script.sh"), null);
  assert.equal(suggestVpnDisconnect(""), null);
});
