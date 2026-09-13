// Exercise the actual registered callbacks. Their collaborators are stubbed:
// this checks which input requests a resume claim; springclaim covers the
// resulting spring state and app-owned scroll behavior.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
type Kind = "touchmove" | "wheel";
const callbacks: Record<Kind, string[]> = { touchmove: [], wheel: [] };
function visit(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(file) === "thread.addEventListener" &&
    node.arguments.length > 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    const kind = node.arguments[0].text;
    if (kind === "touchmove" || kind === "wheel") {
      callbacks[kind].push(node.arguments[1].getText(file));
    }
  }
  ts.forEachChild(node, visit);
}
visit(file);

function dispatch(kind: Kind, x: number, y: number): { claimed: number; prevented: boolean } {
  expect(callbacks[kind]).toHaveLength(1);
  const js = ts.transpileModule(
    `const handler = ${callbacks[kind][0]}; globalThis.handler = handler;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  let claimed = 0;
  let prevented = false;
  const context = {
    startX: 0, startY: 0, peeking: null,
    thread: { classList: { add() {} }, style: { setProperty() {} } },
    noteThreadGesture() {},
    springFinger() {},
    claimResumeEra() { claimed += 1; },
    cancelGlide() {},
    armSpring() {},
  } as Record<string, unknown>;
  runInNewContext(js, context);
  (context.handler as (event: unknown) => void)({
    touches: [{ clientX: x, clientY: y }],
    deltaX: x, deltaY: y,
    preventDefault() { prevented = true; },
  });
  return { claimed, prevented };
}

describe("resume claims from actual thread input handlers", () => {
  it.each([
    ["upward drag", 0, -20, 1, false],
    ["downward drag", 0, 20, 1, false],
    ["short decided drag", 0, 10, 1, false],
    ["leftward peek", -20, 0, 0, true],
    ["rightward horizontal swipe", 20, 0, 0, false],
    ["horizontal swipe with small vertical drift", 20, 9, 0, false],
    ["stationary contact", 0, 0, 0, false],
  ] as const)("%s", (_label, x, y, claimed, prevented) => {
    expect(dispatch("touchmove", x, y)).toEqual({ claimed, prevented });
  });

  it.each([
    ["upward wheel", 0, -20, 1],
    ["downward wheel", 0, 20, 1],
    ["diagonal wheel with vertical travel", 20, 20, 1],
    ["horizontal wheel", 20, 0, 0],
    ["zero wheel delta", 0, 0, 0],
  ] as const)("%s", (_label, x, y, claimed) => {
    expect(dispatch("wheel", x, y)).toEqual({ claimed, prevented: false });
  });
});


describe("resume bottom pins through the production functions", () => {
  it.each([
    ["unchanged position", 3000, 0, 0],
    ["app-driven jump", 2800, 200, 1],
  ] as const)("%s", (_label, initial, delta, freezes) => {
    const bodies = ["scrollToBottom", "noteSpringAppWrite"].map((name) => {
      const fn = file.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
      expect(fn).toBeDefined();
      return fn!.getText(file);
    });
    let frozen = 0;
    const thread = {
      scrollTop: initial as number,
      scrollHeight: 3700,
      clientHeight: 700,
      scrollTo({ top }: { top: number }) {
        this.scrollTop = Math.min(Math.max(0, top), this.scrollHeight - this.clientHeight);
      },
    };
    const context = {
      threadEl: () => thread,
      resumeHolding: () => false,
      resumeWindowOpen: () => true,
      suppressAnim: false,
      pinInstant: false,
      springAppWroteAt: -Infinity,
      performance: { now: () => 1000 },
      springFreeze: () => { frozen += 1; },
      scrollGhostWrite() {},
      holdDiagRecord() {},
      cancelGlide() {},
      startGlide() { throw new Error("Expected the resume pin to be instant"); },
    };
    const js = ts.transpileModule(
      bodies.join("\n") + "\nscrollToBottom();",
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    runInNewContext(js, context);
    expect(thread.scrollTop - initial).toBe(delta);
    expect(frozen).toBe(freezes);
    expect(context.springAppWroteAt).toBe(1000);
  });
});

