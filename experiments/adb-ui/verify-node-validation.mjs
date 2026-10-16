import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { withCommands } from "../command-scope.mjs";
import { REA_CLI_PATH, withFixture } from "./fixture.mjs";

const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    apk: { type: "string" },
    aapt2: { type: "string", default: "aapt2" },
    output: { type: "string" },
  },
});
for (const key of ["serial", "apk", "output"])
  if (!values[key]) throw new Error(`Missing --${key}`);
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const client = new Client({ name: "rea-ui-node-validation", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [REA_CLI_PATH, "mcp"],
  env,
  stderr: "pipe",
});
transport.stderr?.resume();
const observations = [];
const failures = [];
await withCommands((run, signal, settleCommands) =>
  withFixture(
    {
      apk: values.apk,
      aapt2: values.aapt2,
      output,
      serial: values.serial,
      environment: env,
      client,
      transport,
      run,
      signal,
      settleCommands,
    },
    async ({ call, adb, fixture }) => {
      const scope = { serial: values.serial, package: fixture.package };
      const retain = async (kind, value) => {
        observations.push({ kind, value });
        await writeFile(
          join(output, `observation-${observations.length}.json`),
          JSON.stringify({ kind, value }, null, 2),
          { flag: "wx" },
        );
      };
      const find = async (id) => {
        const evidence = await call("find_adb_ui_elements", {
          ...scope,
          selector: { resource_id: `${scope.package}:id/${id}` },
        });
        await retain("selection", evidence);
        assert.equal(evidence.normalized_result.total_matches, 1);
        return evidence.normalized_result;
      };
      const mutate = async (mutation) => {
        const result = await adb([
          "shell",
          "am",
          "broadcast",
          "--receiver-foreground",
          "--user",
          "0",
          "-a",
          `${scope.package}.MUTATE`,
          "-p",
          scope.package,
          "--es",
          "mutation",
          mutation,
        ]);
        await retain("fixture-mutation", result);
        const record = result.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("Broadcast completed:"));
        const match =
          /^Broadcast completed: result=0, data="([a-z]+):(true|false):(-?\d+(?:\.\d+)?):(true|false):(true|false)"$/u.exec(
            record ?? "",
          );
        assert(
          match,
          "Fixture mutation was not acknowledged with state readback",
        );
        assert.equal(match[1], mutation);
        if (mutation === "disable") assert.equal(match[2], "false");
        if (mutation === "move") assert.equal(Number(match[3]), 60);
        if (mutation === "detach") assert.equal(match[4], "false");
        if (mutation === "password") assert.equal(match[5], "true");
      };
      const invoke = async (selection, action) => {
        const reply = await client.callTool(
          {
            name: "perform_adb_ui_action",
            arguments: {
              ...scope,
              snapshot_id: selection.snapshot.id,
              element_id: selection.matches[0].id,
              action,
            },
          },
          { signal, timeout: 60000 },
        );
        await retain("action", reply);
        const data =
          reply.structuredContent ??
          JSON.parse(reply.content.find((part) => part.type === "text").text);
        return { reply, data };
      };
      await call("start_adb_app", scope);
      assert.equal(
        (
          await call("wait_for_adb_ui", {
            ...scope,
            selector: { text: { value: "Sign in" } },
          })
        ).normalized_result.satisfied,
        true,
      );
      for (const mutation of ["disable", "move", "detach", "password"]) {
        await mutate("reset");
        const selected = await find(
          mutation === "password" ? "entry" : "sign_in",
        );
        if (mutation === "password") {
          assert.equal(selected.matches[0].password, false);
          assert.equal(selected.matches[0].text, null);
        }
        await mutate(mutation);
        const result = await invoke(
          selected,
          mutation === "password"
            ? { kind: "set_text", text: "fixture-transition-sentinel" }
            : { kind: "tap" },
        );
        if (
          result.reply.isError !== true ||
          result.data.error?.details?.diagnostics?.runner_failure !==
            "stale_element"
        )
          failures.push({
            mutation,
            reason: "Retained stale node was not refused",
            response: result.data,
          });
      }
      await mutate("reset");
      await mutate("password");
      const password = await find("entry");
      assert.equal(password.matches[0].password, true);
      const sentinel = "fixture-password-sentinel";
      const passwordAction = await invoke(password, {
        kind: "set_text",
        text: sentinel,
      });
      assert.notEqual(passwordAction.reply.isError, true);
      const passwordEvidence = toolContract(
        "perform_adb_ui_action",
      ).outputSchema.parse(passwordAction.data);
      assert.equal(passwordEvidence.normalized_result.action_completed, true);
      assert.equal(passwordEvidence.parameters.action.text, "[redacted]");
      assert.equal(
        JSON.stringify(passwordAction.reply).includes(sentinel),
        false,
      );
      await mutate("reset");
      const plain = await find("entry");
      const plainAction = await invoke(plain, {
        kind: "set_text",
        text: "ordinary caller text",
      });
      assert.notEqual(plainAction.reply.isError, true);
      const plainEvidence = toolContract(
        "perform_adb_ui_action",
      ).outputSchema.parse(plainAction.data);
      assert.equal(
        plainEvidence.parameters.action.text,
        "ordinary caller text",
      );
    },
  ),
);
await writeFile(
  join(output, "receipt.json"),
  JSON.stringify({ failures, observations }, null, 2),
  { flag: "wx" },
);
assert.deepEqual(
  failures,
  [],
  "Stale node validation failed; retained observations describe each case",
);
console.log(
  "Node validation: in-place disabled/moved/removed/password transitions refused; fresh password text redacted and ordinary text preserved; fixture cleanup passed",
);
