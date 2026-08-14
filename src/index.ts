import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Exec, MementoCli } from "./cli.ts";
import { loadConfig, type MementoConfig } from "./config.ts";
import { consolidateOnce, describePass, type PassReport } from "./consolidation.ts";
import { distillPrompt, extractProposal } from "./proposal.ts";
import { describePin, pinMatches, readEnginePin } from "./receipt.ts";
import {
  idleSeconds,
  markEnqueued,
  markJournalled,
  openSession,
  type SessionRecord,
  unenqueued,
} from "./session-state.ts";

/** Kept in step with package.json. */
export const VERSION = "0.1.0";
/** Pi version this extension is verified against. */
export const PI_BASELINE = "0.84.1";
/** MEMENTO engine CLI this wrapper is written against. */
export const ENGINE_BASELINE = "0.1.0";

export * from "./cli.ts";
export * from "./config.ts";
export * from "./consolidation.ts";
export * from "./proposal.ts";
export * from "./receipt.ts";
export * from "./session-state.ts";

/** How long the distiller has to reply before the pass gives its claim back. */
const DISTILL_TIMEOUT_MS = 5 * 60_000;

export default function (pi: ExtensionAPI) {
  let config: MementoConfig | undefined;
  let record: SessionRecord | undefined;
  let cli: MementoCli | undefined;
  /** Set only once the prefix has actually been put in front of the model, by us. */
  let prefixMaterialized = false;
  let prefixText: string | undefined;
  let pendingDistill: ((text: string) => void) | undefined;

  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadConfig(ctx.cwd);
      cli = new MementoCli({
        store: config.store,
        queue: config.queue,
        ...(config.adapterFile ? { adapterFile: config.adapterFile } : {}),
        binary: config.binary,
        exec,
      });

      // Provenance first: a store is only as trustworthy as the engine that gates it, and
      // the engine's identity comes from the install record, never from its own words.
      const pin = readEnginePin("memento");
      if (!pinMatches(pin, config.expectedRev)) {
        ctx.ui.notify(
          `MEMENTO: this project pins ${config.expectedRev?.slice(0, 12)} but the installed engine is ${pin?.rev?.slice(0, 12) ?? "untraceable"}. Not consolidating against an engine the project did not ask for.`,
          "error",
        );
        cli = undefined;
        return;
      }
      ctx.ui.setStatus("memento", describePin(pin));

      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) return;
      record = openSession(config.store, sessionId);

      // Crash recovery, before anything else: journal material that was never enqueued is
      // material no consolidation will ever see.
      for (const orphan of unenqueued(config.store, sessionId)) {
        const enqueued = await cli.enqueue(orphan.id);
        if (enqueued.code === 0) markEnqueued(config.store, orphan);
      }

      // The prefix, injected. Read now so the `context` handler has it, and so the gate
      // check can honestly say it was materialized.
      const prefix = await cli.prefix();
      if (
        prefix.code === 0 &&
        typeof prefix.payload?.text === "string" &&
        prefix.payload.text.trim() !== ""
      ) {
        prefixText = prefix.payload.text;
      }
    } catch (e) {
      ctx.ui.notify(`MEMENTO: ${(e as Error).message}`, "error");
      cli = undefined;
    }
  });

  // Injection point. Pi hands over the messages before they go to the provider; the store's
  // prefix rides in front of them, and only then is it materialized.
  pi.on("context", async (event) => {
    if (!prefixText) return;
    prefixMaterialized = true;
    return {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `# Memory\n\n${prefixText}` }],
        } as never,
        ...event.messages,
      ],
    };
  });

  // The distiller's reply arrives as an ordinary assistant message.
  pi.on("message_end", async (event) => {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !pendingDistill) return;
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((p) =>
                (p as { type?: string; text?: string })?.type === "text"
                  ? ((p as { text?: string }).text ?? "")
                  : "",
              )
              .join("\n")
          : "";
    if (text.trim() !== "") pendingDistill(text);
  });

  pi.on("session_shutdown", async () => {
    // Session exit does the cheap half and nothing else: no distillation, no git.
    if (!cli || !config || !record) return;
    const enqueued = await cli.enqueue(record.id);
    if (enqueued.code === 0) record = markEnqueued(config.store, record);
  });

  pi.registerCommand("memento", {
    description: "MEMENTO — session memory: journal as you go, consolidate when it is due",
    handler: async (args, ctx) => {
      if (!cli || !config || !record) {
        ctx.ui.notify(
          "MEMENTO: not armed in this session — check .pi/memento.json and the engine install.",
          "error",
        );
        return;
      }
      const [verb, ...rest] = args
        .trim()
        .split(/\s+/)
        .filter((a) => a !== "");
      const text = rest.join(" ");

      switch (verb) {
        case undefined:
        case "status":
          return void (await printStatus(cli, ctx, config));
        case "journal": {
          if (text === "")
            return void ctx.ui.notify("usage: /memento journal <what happened>", "error");
          const r = await cli.journal(record.id, text);
          if (r.code !== 0)
            return void ctx.ui.notify(
              `MEMENTO: journal refused — ${r.error ?? `exit ${r.code}`}`,
              "error",
            );
          record = markJournalled(config.store, record);
          return void ctx.ui.notify("MEMENTO: journalled.", "info");
        }
        case "recall": {
          if (text === "") return void ctx.ui.notify("usage: /memento recall <query>", "error");
          const r = await cli.recall(text, { limit: 8 });
          if (r.code !== 0)
            return void ctx.ui.notify(
              `MEMENTO: recall failed — ${r.error ?? `exit ${r.code}`}`,
              "error",
            );
          const hits = r.payload?.hits ?? [];
          ctx.ui.setWidget("memento-recall", [
            `recall "${text}" — ${hits.length} hit(s)`,
            ...hits.map((h) => `  ${JSON.stringify(h)}`),
          ]);
          return;
        }
        case "consolidate":
          return void (await runConsolidation(cli, ctx, config, rest[0]));
        default:
          return void ctx.ui.notify(
            `MEMENTO: unknown subcommand "${verb}". Try status, journal, recall, consolidate.`,
            "error",
          );
      }
    },
  });

  async function printStatus(
    client: MementoCli,
    ctx: ExtensionContext,
    cfg: MementoConfig,
  ): Promise<void> {
    const pending = await client.pending();
    const lines = [
      describePin(readEnginePin("memento")),
      `store ${cfg.store}`,
      `session ${record?.id ?? "—"}${record?.journalCreated ? " (journalled)" : ""}${record?.enqueued ? " (enqueued)" : ""}`,
      `prefix ${prefixMaterialized ? "injected" : prefixText ? "read, not yet injected" : "empty"}`,
    ];
    for (const entry of pending.payload?.pending ?? []) {
      lines.push(`  pending ${entry.session} · ${entry.deferrals} deferral(s)`);
    }
    if (pending.payload?.backlog?.breached) {
      lines.push(
        `  BACKLOG BREACHED: ${pending.payload.backlog.message ?? pending.payload.backlog.reason ?? "consolidation is falling behind"}`,
      );
    }
    ctx.ui.setWidget("memento-status", lines);
  }

  /**
   * One bounded pass, on the operator's word or when the backlog warrants it. The host
   * model is the distiller: it is asked for a proposal and the pass waits for its reply.
   */
  async function runConsolidation(
    client: MementoCli,
    ctx: ExtensionContext,
    cfg: MementoConfig,
    explicitSession?: string,
  ): Promise<void> {
    const pending = await client.pending();
    if (pending.code !== 0) {
      ctx.ui.notify(
        `MEMENTO: cannot read the queue — ${pending.error ?? `exit ${pending.code}`}`,
        "error",
      );
      return;
    }
    const entries = pending.payload?.pending ?? [];
    const target = explicitSession
      ? entries.find((e) => e.session === explicitSession)
      : entries[0];
    if (!target) {
      ctx.ui.notify(
        explicitSession
          ? `MEMENTO: ${explicitSession} is not pending.`
          : "MEMENTO: nothing pending.",
        "info",
      );
      return;
    }
    if (target.session === record?.id) {
      ctx.ui.notify(
        "MEMENTO: this session's own material is consolidated later, never mid-session.",
        "info",
      );
      return;
    }

    const idle = idleSeconds(undefined, target.enqueued_at);
    if (idle < cfg.minIdleSeconds) {
      ctx.ui.notify(
        `MEMENTO: ${target.session} has only been idle ${idle}s. Coming back later.`,
        "info",
      );
      return;
    }

    ctx.ui.notify(`MEMENTO: consolidating ${target.session}…`, "info");
    const report = await consolidateOnce({
      cli: client,
      session: target.session,
      idleSeconds: idle,
      prefixMaterialized,
      distill: async (input) => {
        const reply = await askTheModel(distillPrompt(input));
        if (reply === undefined) return undefined;
        try {
          return extractProposal(reply);
        } catch {
          return undefined;
        }
      },
    });
    announce(ctx, report);
  }

  /** Ask the host model and wait for its next message, bounded. */
  function askTheModel(prompt: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingDistill = undefined;
        resolve(undefined);
      }, DISTILL_TIMEOUT_MS);
      pendingDistill = (text) => {
        clearTimeout(timer);
        pendingDistill = undefined;
        resolve(text);
      };
      pi.sendUserMessage(prompt);
    });
  }

  function announce(ctx: ExtensionContext, report: PassReport): void {
    const described = describePass(report);
    ctx.ui.notify(described.text, described.level);
    if (report.released === false) {
      ctx.ui.notify(
        `MEMENTO: the claim on ${report.session} was NOT released. It expires on its TTL; until then that session cannot be consolidated.`,
        "error",
      );
    }
  }
}
