import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "vitest";

import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import type { CliResult } from "../../support/cli/cliFixture.js";
import { workspaceCliTest as test } from "../../support/cli/workspaceCliFixture.js";
import type { TestWorkspace } from "../../support/workspace/workspaceFixture.js";

const expectExitCode = (
  command: string,
  result: CliResult,
  expected: number,
): void => {
  if (result.exitCode === expected) return;
  throw new Error(
    `CLI ${command} exited ${String(result.exitCode)} (signal ${String(result.signal)}); expected ${expected}. stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
};

const isolatedEnvironment = async (workspace: TestWorkspace) => {
  let path = "";
  if (process.platform === "linux") {
    // Keep optional tools off PATH while allowing process-ownership checks.
    const bin = await workspace.mkdir("bin");
    await symlink("/bin/ps", workspace.path("bin", "ps"));
    path = bin;
  }
  return {
    PATH: path,
    HOME: workspace.home,
    USERPROFILE: workspace.home,
    APPDATA: workspace.path("appdata"),
    LOCALAPPDATA: workspace.path("localappdata"),
    XDG_CONFIG_HOME: workspace.path("config"),
    XDG_CACHE_HOME: workspace.path("cache"),
    TEMP: workspace.root,
    TMP: workspace.root,
    ...(process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot ?? "" }
      : {}),
    HOPPER_LAUNCHER_PATH: workspace.path("missing-hopper"),
    REA_LOG_LEVEL: "silent",
    REA_JEB_MCP_TIMEOUT_MS: "1.5",
  };
};

test("keeps compiled CLI discovery usable while JEB rejects its malformed timeout", async ({
  cli,
  workspace,
}) => {
  const environment = await isolatedEnvironment(workspace);
  for (const command of ["capabilities", "providers"]) {
    const result = await cli.run({
      arguments: [command, "--json"],
      environment,
    });
    expectExitCode(command, result, 0);
    expect(result.json).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          provider: expect.objectContaining({ id: "rea-artifact-graph" }),
        }),
      ]),
    });
  }
  const refusal = await cli.run({
    arguments: ["inspect-jeb-client", "--json"],
    environment,
  });
  expectExitCode("inspect-jeb-client", refusal, 1);
  expect(refusal.json).toMatchObject({
    code: "configuration_invalid",
    details: { settings: [{ setting: "REA_JEB_MCP_TIMEOUT_MS" }] },
  });
});

test("starts production stdio MCP and retains peer requests around a JEB configuration refusal", async ({
  workspace,
}) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    cwd: workspace.root,
    env: await isolatedEnvironment(workspace),
    stderr: "pipe",
  });
  const client = new Client({ name: "jeb-isolation-acceptance", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    await client.connect(transport);
    await client.ping();
    const definition = (await client.listTools()).tools.find(
      ({ name }) => name === "inspect_jeb_client",
    );
    if (definition === undefined)
      throw new Error(`Production MCP omitted inspect_jeb_client: ${stderr}`);
    const refusal = parseMcpToolError(
      await client.callTool(
        { name: "inspect_jeb_client", arguments: {} },
        { toolDefinition: definition },
      ),
    );
    expect(refusal.error).toMatchObject({
      code: "configuration_invalid",
      details: { settings: [{ setting: "REA_JEB_MCP_TIMEOUT_MS" }] },
    });
    await client.ping();
  } finally {
    await client.close();
    await transport.close();
  }
});
