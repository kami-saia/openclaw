import { addAbortListener } from "node:events";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { Locator, Page } from "playwright-core";
import { resolveActInteractionTimeoutMs } from "./act-policy.js";
import type { BrowserFormField } from "./client-actions.types.js";
import { normalizeBrowserEvaluateFunctionSource } from "./evaluate-source.js";
import { evaluateBrowserFunction } from "./page-function-runtime.js";
import {
  type CursorPoint,
  humanClickSettleMs,
  humanCursorPath,
  humanCursorStepDelayMs,
  humanKeyDelaysMs,
  humanSubmitPauseMs,
  isHumanInputPacingEnabled,
  typeWithHumanPacing,
} from "./human-pacing.js";
import {
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import {
  assertInteractionCurrent,
  type ElementInteractionOptions,
  getRestoredPageForTarget,
  type GuardedInteractionOptions,
  type InteractionTargetOptions,
  runCancellablePageInteraction,
  runGuardedPageInteraction,
  throwIfInteractionAborted,
  toFriendlyInteractionError,
} from "./pw-tools-core.interactions.navigation.js";
import { normalizeTimeoutMs, requireRef } from "./pw-tools-core.shared.js";

export async function highlightViaPlaywright(
  opts: InteractionTargetOptions & {
    ref: string;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const ref = requireRef(opts.ref);
  try {
    await refLocator(page, ref).highlight();
  } catch (err) {
    throw toFriendlyInteractionError(err, ref);
  }
}

export async function clickViaPlaywright(
  opts: ElementInteractionOptions & {
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
    delayMs?: number;
    resolvedPage?: Page;
  },
): Promise<void> {
  await runElementInteraction(
    opts,
    async (locator, { timeout, signal, page }) => {
      const delayMs = opts.delayMs ?? 0;
      if (isHumanInputPacingEnabled()) {
        // FORK: approach the element along a human cursor path, then settle briefly
        // before pressing, instead of teleporting straight onto the target.
        await moveCursorToLocator(page, locator, opts.signal);
        throwIfInteractionAborted(opts.signal);
        await sleepWithAbort(delayMs > 0 ? delayMs : humanClickSettleMs(), opts.signal);
        const assertion = assertInteractionCurrent(opts);
        if (assertion) {
          await assertion;
        }
        throwIfInteractionAborted(opts.signal);
      } else if (delayMs > 0) {
        await locator.hover({ timeout, signal });
        throwIfInteractionAborted(opts.signal);
        await sleepWithAbort(delayMs, opts.signal);
        const assertion = assertInteractionCurrent(opts);
        if (assertion) {
          await assertion;
        }
        throwIfInteractionAborted(opts.signal);
      }
      const clickOptions = { timeout, signal, button: opts.button, modifiers: opts.modifiers };
      await (opts.doubleClick ? locator.dblclick(clickOptions) : locator.click(clickOptions));
    },
    opts.resolvedPage,
  );
}

/**
 * Last known synthetic cursor position per page. Playwright's mouse starts at
 * (0,0) and jumps straight to each target, which produces a pointer trace no
 * human hand makes. Tracking the previous point lets us interpolate from it.
 */
const lastCursorPositionByPage = new WeakMap<Page, CursorPoint>();

/**
 * Glide the virtual cursor to (x, y) along a curved, variable-speed path,
 * dispatching real mousemove events along the way.
 */
async function moveCursorLikeHuman(
  page: Page,
  to: CursorPoint,
  signal?: AbortSignal,
): Promise<void> {
  const from = lastCursorPositionByPage.get(page) ?? {
    x: Math.max(0, to.x - 320),
    y: Math.max(0, to.y - 210),
  };
  for (const point of humanCursorPath(from, to)) {
    throwIfInteractionAborted(signal);
    await page.mouse.move(point.x, point.y);
    await sleepWithAbort(humanCursorStepDelayMs(), signal);
  }
  lastCursorPositionByPage.set(page, to);
}

/** Move the cursor onto an element's box before it is clicked. */
async function moveCursorToLocator(
  page: Page,
  locator: ReturnType<typeof resolveInteractionElement>["locator"],
  signal?: AbortSignal,
): Promise<void> {
  // Best effort: the glide is cosmetic and must never fail the click itself.
  const box = await Promise.resolve()
    .then(() => locator.boundingBox())
    .catch(() => null);
  throwIfInteractionAborted(signal);
  if (!box) {
    return;
  }
  // Aim for a random point inside the element rather than its exact centre;
  // always hitting dead centre is itself a tell.
  await moveCursorLikeHuman(
    page,
    {
      x: Math.round(box.x + box.width * (0.3 + Math.random() * 0.4)),
      y: Math.round(box.y + box.height * (0.3 + Math.random() * 0.4)),
    },
    signal,
  );
}

export async function clickCoordsViaPlaywright(
  opts: GuardedInteractionOptions & {
    x: number;
    y: number;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    delayMs?: number;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  await runGuardedPageInteraction(page, opts, async () => {
    if (isHumanInputPacingEnabled()) {
      await moveCursorLikeHuman(page, { x: opts.x, y: opts.y }, opts.signal);
    }
    await page.mouse.click(opts.x, opts.y, {
      button: opts.button,
      clickCount: opts.doubleClick ? 2 : 1,
      delay: opts.delayMs ?? 0,
    });
  });
}

function resolveInteractionElement(
  page: Page,
  resolved: Pick<ElementInteractionOptions, "ref" | "selector">,
) {
  return {
    label: resolved.ref ?? resolved.selector!,
    locator: resolved.ref
      ? refLocator(page, requireRef(resolved.ref))
      : page.locator(resolved.selector!),
  };
}

async function runElementInteraction(
  opts: ElementInteractionOptions,
  // FORK(human pacing): page is passed so cursor glides need not call locator.page().
  action: (
    locator: Locator,
    options: { timeout: number; signal: AbortSignal; page: Page },
  ) => Promise<unknown>,
  resolvedPage?: Page,
  resolveTimeout = resolveActInteractionTimeoutMs,
): Promise<void> {
  const page = resolvedPage ?? (await getRestoredPageForTarget(opts));
  if (resolvedPage) {
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  }
  const { label, locator } = resolveInteractionElement(page, opts);
  const timeout = resolveTimeout(opts.timeoutMs);
  await runCancellablePageInteraction(
    page,
    opts,
    (signal) => action(locator, { timeout, signal, page }),
    label,
  );
}

export async function hoverViaPlaywright(opts: ElementInteractionOptions): Promise<void> {
  await runElementInteraction(opts, (locator, options) => locator.hover(options));
}

export async function dragViaPlaywright(
  opts: GuardedInteractionOptions & {
    startRef?: string;
    startSelector?: string;
    endRef?: string;
    endSelector?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const { label: startLabel, locator: startLocator } = resolveInteractionElement(page, {
    ref: opts.startRef,
    selector: opts.startSelector,
  });
  const { label: endLabel, locator: endLocator } = resolveInteractionElement(page, {
    ref: opts.endRef,
    selector: opts.endSelector,
  });
  await runCancellablePageInteraction(
    page,
    opts,
    async (signal) =>
      await startLocator.dragTo(endLocator, {
        timeout: resolveActInteractionTimeoutMs(opts.timeoutMs),
        signal,
      }),
    `${startLabel} -> ${endLabel}`,
  );
}

export async function selectOptionViaPlaywright(
  opts: ElementInteractionOptions & {
    values: string[];
  },
): Promise<void> {
  await runElementInteraction(opts, (locator, options) =>
    locator.selectOption(opts.values, options),
  );
}

export async function pressKeyViaPlaywright(
  opts: GuardedInteractionOptions & {
    key: string;
    delayMs?: number;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  await runGuardedPageInteraction(page, opts, async () => {
    await page.keyboard.press(opts.key, {
      delay: opts.delayMs ?? 0,
    });
  });
}

export async function insertTextViaPlaywright(
  opts: GuardedInteractionOptions & { text: string },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  await runGuardedPageInteraction(page, opts, async () => {
    try {
      // Native insertion preserves the focused frame and selection without reading the clipboard.
      await page.keyboard.insertText(opts.text);
    } catch {
      // Playwright errors can contain the inserted text, including pasted passwords.
      throw new Error(
        "Unable to paste text into the browser. Focus an editable field and try again.",
      );
    }
  });
}

export async function typeViaPlaywright(
  opts: ElementInteractionOptions & {
    text: string;
    submit?: boolean;
    slowly?: boolean;
  },
): Promise<void> {
  if (!isHumanInputPacingEnabled()) {
    await runElementInteraction(opts, async (locator, { timeout, signal }) => {
      if (opts.slowly) {
        await locator.click({ timeout, signal });
        const assertion = assertInteractionCurrent(opts);
        if (assertion) {
          await assertion;
        }
        throwIfInteractionAborted(opts.signal);
        await locator.type(opts.text, { timeout, signal, delay: 75 });
      } else {
        await locator.fill(opts.text, { timeout, signal });
      }
      if (opts.submit) {
        const assertion = assertInteractionCurrent(opts);
        if (assertion) {
          await assertion;
        }
        throwIfInteractionAborted(opts.signal);
        await locator.press("Enter", { timeout, signal });
      }
    });
    return;
  }
  const text = opts.text ?? "";
  await runElementInteraction(opts, async (locator, { timeout, signal }) => {
    // FORK: always dispatch real, jittered keystrokes. `fill()` sets the value with
    // no key events and uniform `delay: 75` typing is equally unlike a human.
    await locator.click({ timeout, signal });
    {
      const assertion = assertInteractionCurrent(opts);
      if (assertion) {
        await assertion;
      }
    }
    throwIfInteractionAborted(opts.signal);
    await sleepWithAbort(humanClickSettleMs(), opts.signal);
    throwIfInteractionAborted(opts.signal);
    // Preserve fill() replace semantics via a real select-all + delete.
    await locator.press("ControlOrMeta+a", { timeout, signal });
    await locator.press("Delete", { timeout, signal });
    throwIfInteractionAborted(opts.signal);
    await typeWithHumanPacing({
      text,
      delays: humanKeyDelaysMs(text, opts.slowly ? undefined : 46),
      pressKey: async (char, delayMs) => {
        await locator.type(char, { timeout, signal, delay: 0 });
        await sleepWithAbort(delayMs, opts.signal);
      },
      throwIfAborted: () => throwIfInteractionAborted(opts.signal),
    });
    if (opts.submit) {
      const assertion = assertInteractionCurrent(opts);
      if (assertion) {
        await assertion;
      }
      throwIfInteractionAborted(opts.signal);
      await sleepWithAbort(humanSubmitPauseMs(), opts.signal);
      throwIfInteractionAborted(opts.signal);
      await locator.press("Enter", { timeout, signal });
    }
  });
}

export async function fillFormViaPlaywright(
  opts: GuardedInteractionOptions & {
    fields: BrowserFormField[];
    timeoutMs?: number;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveActInteractionTimeoutMs(opts.timeoutMs);
  for (const field of opts.fields) {
    const { ref, type, value: rawValue } = field;
    const value = String(rawValue ?? "");
    const locator = refLocator(page, ref);
    await runCancellablePageInteraction(
      page,
      opts,
      async (signal) => {
        if (type === "checkbox" || type === "radio") {
          const checked =
            rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true";
          await locator.setChecked(checked, { timeout, signal });
        } else {
          await locator.fill(value, { timeout, signal });
        }
      },
      ref,
    );
  }
}

export async function evaluateViaPlaywright(
  opts: GuardedInteractionOptions & {
    fn: string;
    ref?: string;
    timeoutMs?: number;
  },
): Promise<unknown> {
  const fnSource = normalizeBrowserEvaluateFunctionSource(
    opts.fn,
    opts.ref ? { argumentName: "el" } : undefined,
  );
  const page = await getRestoredPageForTarget(opts);
  // Clamp evaluate timeout to prevent permanently blocking Playwright's command queue.
  // Without this, a long-running async evaluate blocks all subsequent page operations
  // because Playwright serializes CDP commands per page.
  //
  // NOTE: Playwright's { timeout } on evaluate only applies to installing the function,
  // NOT to its execution time. We must inject a Promise.race timeout into the browser
  // context itself so async functions are bounded.
  const outerTimeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);
  // Leave headroom for routing/serialization overhead so the outer request timeout
  // doesn't fire first and strand a long-running evaluate.
  let evaluateTimeout = Math.max(1000, Math.min(120_000, outerTimeout - 500));
  evaluateTimeout = Math.min(evaluateTimeout, outerTimeout);

  const signal = opts.signal;
  const onAbort = () => {
    if (isBrowserObservedDialogBlockedError(signal?.reason)) {
      return;
    }
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      page,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
    }).catch(() => {});
  };
  if (signal?.aborted) {
    onAbort();
    throw signal.reason ?? new Error("aborted");
  }
  const abortListener = signal && addAbortListener(signal, onAbort);

  try {
    const args = { fnSource, timeoutMs: evaluateTimeout };
    const ref = opts.ref;
    const action = ref
      ? async () => await refLocator(page, ref).evaluate(evaluateBrowserFunction, args)
      : async () => await page.evaluate(evaluateBrowserFunction, args);
    return await runGuardedPageInteraction(page, opts, action);
  } finally {
    abortListener?.[Symbol.dispose]();
  }
}

export async function scrollIntoViewViaPlaywright(opts: ElementInteractionOptions): Promise<void> {
  await runElementInteraction(
    opts,
    (locator, options) => locator.scrollIntoViewIfNeeded(options),
    undefined,
    (timeoutMs) => normalizeTimeoutMs(timeoutMs, 20_000),
  );
}
