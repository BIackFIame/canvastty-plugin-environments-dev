// The real ssh-host and remote-container services behind CanvasTTY's own orchestration code: an orchestrator lists the
// person's servers and starts subagents on them through spawn_agent's environment. Runs when CANVASTTY_REPO points at a
// CanvasTTY checkout whose core has spawn_agent environments (B5) and per-server caps; skipped otherwise. No real ssh:
// the fake one runs the "server" side locally.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeSsh, repo, startService, temp } from "./helpers.mjs";

const REPO = process.env.CANVASTTY_REPO;
const PLUGIN = "canvastty-environments";
const root = new URL("../", import.meta.url).pathname;
const core = REPO && existsSync(join(REPO, "src/main/services/EnvironmentRegistry.ts"))
  && /capBy/u.test(readFileSync(join(REPO, "src/main/services/EnvironmentRegistry.ts"), "utf8"));
const skip = core ? false : "needs CANVASTTY_REPO with spawn_agent environments and per-server caps";

async function setup(t) {
  const [{ validatePluginManifest }, { EnvironmentRegistry }, { TerminalManager }, { AgentControlService }, { ScopedOrchestrationHandler }, helpers] = await Promise.all([
    import(join(REPO, "src/main/services/PluginManager.ts")),
    import(join(REPO, "src/main/services/EnvironmentRegistry.ts")),
    import(join(REPO, "src/main/services/TerminalManager.ts")),
    import(join(REPO, "src/main/services/AgentControlService.ts")),
    import(join(REPO, "src/main/services/agent-browser/OrchestrationTools.ts")),
    import(join(REPO, "tests/helpers/terminal.mjs"))
  ]);
  const manifest = validatePluginManifest(JSON.parse(readFileSync(join(root, "canvastty.plugin.json"), "utf8")));
  const ssh = await fakeSsh(t);
  const project = await repo(t, "project");
  const serverFolder = await temp(t, "server");
  const hosts = [
    { label: "Build box", sshHost: "build-box", sshUser: "deploy", workspaces: [{ localPath: project, remotePath: serverFolder }] },
    { label: "gpu", sshHost: "10.0.0.9", sshPort: 2222, workspaces: [{ localPath: project, remotePath: serverFolder }] },
    { label: "ci.example.org", sshHost: "ci", workspaces: [{ localPath: project, remotePath: serverFolder }] }
  ];
  const storage = { "storage.get": ({ key }) => (key === "hosts" ? hosts : null) };
  const services = {};
  const pluginCalls = [];
  for (const id of ["ssh-host", "remote-container"]) {
    services[id] = startService(t, id, { dataDir: await temp(t, "data"), env: { PATH: `${ssh.dir}:${process.env.PATH}` }, host: storage });
  }
  const registry = new EnvironmentRegistry({
    providers: () => manifest.services.filter((service) => services[service.id] && service.environments)
      .map((service) => ({ pluginId: PLUGIN, pluginName: manifest.name, serviceId: service.id, kinds: service.environments, secrets: false })),
    call: (_pluginId, serviceId, method, params) => {
      pluginCalls.push({ serviceId, method, params: structuredClone(params) });
      return services[serviceId].request(method, params);
    },
    secret: async () => null
  });
  const spawned = [];
  const terminals = new TerminalManager(() => undefined, helpers.availableRegistry(), undefined, undefined, true, helpers.fakeSpawner(spawned));
  t.after(() => terminals.shutdown());
  terminals.configureEnvironments(registry);
  const control = new AgentControlService(terminals, { limits: () => ({ maxDepth: 2, maxSubagents: 8 }) });
  const handler = new ScopedOrchestrationHandler(control, null, {
    cli: () => "available", limits: () => null,
    environments: () => terminals.delegatedEnvironments(), refreshEnvironments: () => terminals.refreshDelegatedEnvironments()
  });
  const orchestrator = terminals.create({ provider: "codex", profile: "auto", cwd: project, position: { x: 0, y: 0 }, role: "orchestrator" });
  const call = (tool, args = {}) => handler.execute(orchestrator.id, { id: randomUUID(), tool, arguments: args });
  const spawn = (host) => call("spawn_agent", { provider: "opencode", cwd: project, environment: { pluginId: PLUGIN, kind: "ssh-host", options: { host } } });
  return { serverFolder, pluginCalls, spawned, terminals, call, spawn };
}

const refused = (pattern) => (error) => error.bridgeError?.code === "INVALID_REQUEST" && pattern.test(error.message);
const waitFor = async (predicate) => {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met in time.");
};

test("list_providers shows the person's servers by label, never an address, user, port or folder", { skip }, async (t) => {
  const { serverFolder, call } = await setup(t);
  const { environments } = await call("list_providers");
  assert.deepEqual(environments.map((entry) => [entry.kind, entry.capBy, entry.maxParallel, entry.servers]), [
    ["ssh-host", "host", 2, [{ name: "Build box", running: 0 }, { name: "gpu", running: 0 }]],
    ["remote-container", "host", 1, [{ name: "Build box", running: 0 }, { name: "gpu", running: 0 }]]
  ]);
  assert.deepEqual(environments.map((entry) => entry.options), [[{ key: "host", kind: "text" }], [{ key: "host", kind: "text" }]],
    "network, image and workspace stay the person's");
  const text = JSON.stringify(environments);
  for (const secret of ["build-box", "deploy", "10.0.0.9", "2222", "ci.example.org", serverFolder]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("an orchestrator starts subagents on a server by its label, two per server; addresses and other spellings are refused", { skip }, async (t) => {
  const { pluginCalls, spawned, terminals, spawn } = await setup(t);
  const before = spawned.length;
  const first = await spawn("Build box");
  assert.deepEqual(first.environment, { pluginId: PLUGIN, kind: "ssh-host" });
  assert.equal(first.profile, "normal", "no local hooks reach the server, so the orchestrator's auto becomes normal");
  await waitFor(() => spawned.length === before + 1);
  const launch = spawned.at(-1);
  assert.match(launch.command, /(?:^|\/)ssh$/u);
  assert.ok(launch.args.includes("deploy@build-box"), "the plugin, not the agent, knows the address");
  const prepare = pluginCalls.find((entry) => entry.method === "canvastty.environment.prepare");
  assert.deepEqual(prepare.params.options, { host: "Build box" });
  const wrap = pluginCalls.find((entry) => entry.method === "canvastty.environment.wrap");
  assert.deepEqual(Object.keys(wrap.params.env).filter((key) => key.startsWith("CANVASTTY_")), []);
  assert.equal(terminals.getMetadata(first.sessionId).environment.label, "ssh Build box");
  await spawn("Build box");
  await assert.rejects(spawn("Build box"), refused(/Build box \(SSH server\) already runs 2 subagents, the most CanvasTTY Environments allows on one server at once/u));
  await spawn("gpu");
  for (const other of ["build-box", "BUILD BOX", "10.0.0.9", "ci.example.org", ""]) {
    await assert.rejects(spawn(other), refused(/not one of the servers the person set up|pass options\.host/u), other);
  }
  assert.equal(pluginCalls.filter((entry) => entry.method === "canvastty.environment.choices").length, 2, "one read per kind, cached");
});
