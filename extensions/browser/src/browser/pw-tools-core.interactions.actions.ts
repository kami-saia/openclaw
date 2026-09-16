import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page } from "playwright-core";
import { ACT_MAX_CLICK_DELAY_MS, resolveActInteractionTimeoutMs } from "./act-policy.js";
import type { BrowserFormField } from "./client-actions.types.js";
import { normalizeBrowserEvaluateFunctionSource } from "./evaluate-source.js";
import { DEFAULT_FILL_FIELD_TYPE } from "./form-fields.js";
import {
  type CursorPoint,
  humanClickSettleMs,
  humanCursorPath,
  humanCursorStepDelayMs,
  humanKeyDelaysMs,
  humanSubmitPauseMs,
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
  awaitNavigationGuardedInteraction,
  createAbortPromiseWithListener,
  type ElementInteractionOptions,
  getRestoredPageForTarget,
  type GuardedInteractionOptions,
  type InteractionTargetOptions,
  interactionNavigationPolicy,
  reconcileRemoteDialogAfterActionSettled,
  resolveBoundedDelayMs,
  runCancellablePageInteraction,
  throwIfInteractionAborted,
  toFriendlyInteractionError,
} from "./pw-tools-core.interactions.navigation.js";
import { normalizeTimeoutMs, requireRef, requireRefOrSelector } from "./pw-tools-core.shared.js";

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
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = opts.resolvedPage ?? (await getRestoredPageForTarget(opts));
  if (opts.resolvedPage) {
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  }
  const { label, locator } = resolveInteractionElement(page, resolved);
  const timeout = resolveActInteractionTimeoutMs(opts.timeoutMs);
  await runCancellablePageInteraction(
    page,
    opts,
    async (signal) => {
      const delayMs = resolveBoundedDelayMs(opts.delayMs, "click delayMs", ACT_MAX_CLICK_DELAY_MS);
      // Approach the element along a human cursor path, then settle briefly
      // before pressing, instead of teleporting straight onto the target.
      await moveCursorToLocator(page, locator, opts.signal);
      throwIfInteractionAborted(opts.signal);
      await sleepWithAbort(delayMs > 0 ? delayMs : humanClickSettleMs(), opts.signal);
      throwIfInteractionAborted(opts.signal);
      const clickOptions = { timeout, signal, button: opts.button, modifiers: opts.modifiers };
      await (opts.doubleClick ? locator.dblclick(clickOptions) : locator.click(clickOptions));
    },
    label,
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
  const box = await locator.boundingBox();
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
    await moveCursorLikeHuman(page, { x: opts.x, y: opts.y }, opts.signal);
    await page.mouse.click(opts.x, opts.y, {
      button: opts.button,
      clickCount: opts.doubleClick ? 2 : 1,
      delay: resolveBoundedDelayMs(opts.delayMs, "clickCoords delayMs", ACT_MAX_CLICK_DELAY_MS),
    });
  });
}

async function runGuardedPageInteraction<T>(
  page: Page,
  opts: GuardedInteractionOptions,
  action: () => Promise<T>,
): Promise<T> {
  // Mouse and keyboard primitives lack native cancellation. Keep their guard
  // alive after foreground interruption until the underlying operation settles.
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
  try {
    return await awaitNavigationGuardedInteraction(
      {
        action,
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
      },
      abortPromise,
      opts.signal,
      () => reconcileRemoteDialogAfterActionSettled(page, opts.signal),
    );
  } finally {
    cleanup();
  }
}

function resolveInteractionElement(page: Page, resolved: ReturnType<typeof requireRefOrSelector>) {
  return {
    label: resolved.ref ?? resolved.selector!,
    locator: resolved.ref
      ? refLocator(page, requireRef(resolved.ref))
      : page.locator(resolved.selector!),
  };
}

export async function hoverViaPlaywright(opts: ElementInteractionOptions): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const { label, locator } = resolveInteractionElement(page, resolved);
  await runCancellablePageInteraction(
    page,
    opts,
    async (signal) =>
      await locator.hover({ timeout: resolveActInteractionTimeoutMs(opts.timeoutMs), signal }),
    label,
  );
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
  const resolvedStart = requireRefOrSelector(opts.startRef, opts.startSelector);
  const resolvedEnd = requireRefOrSelector(opts.endRef, opts.endSelector);
  const page = await getRestoredPageForTarget(opts);
  const { label: startLabel, locator: startLocator } = resolveInteractionElement(
    page,
    resolvedStart,
  );
  const { label: endLabel, locator: endLocator } = resolveInteractionElement(page, resolvedEnd);
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
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  if (!opts.values?.length) {
    throw new Error("values are required");
  }
  const page = await getRestoredPageForTarget(opts);
  const { label, locator } = resolveInteractionElement(page, resolved);
  await runCancellablePageInteraction(
    page,
    opts,
    async (signal) => {
      await locator.selectOption(opts.values, {
        timeout: resolveActInteractionTimeoutMs(opts.timeoutMs),
        signal,
      });
    },
    label,
  );
}

export async function pressKeyViaPlaywright(
  opts: GuardedInteractionOptions & {
    key: string;
    delayMs?: number;
  },
): Promise<void> {
  const key = normalizeOptionalString(opts.key) ?? "";
  if (!key) {
    throw new Error("key is required");
  }
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await runGuardedPageInteraction(page, opts, async () => {
    await page.keyboard.press(key, {
      delay: resolveNonNegativeIntegerOption(opts.delayMs, 0),
    });
  });
}

export async function typeViaPlaywright(
  opts: ElementInteractionOptions & {
    text: string;
    submit?: boolean;
    slowly?: boolean;
  },
): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const text = opts.text ?? "";
  const page = await getRestoredPageForTarget(opts);
  const { label, locator } = resolveInteractionElement(page, resolved);
  const timeout = resolveActInteractionTimeoutMs(opts.timeoutMs);
  await runCancellablePageInteraction(
    page,
    opts,
    async (signal) => {
      // Always dispatch real keystrokes. `fill()` sets the value in one shot
      // without any key events, which is trivially detectable; uniform
      // `delay: 75` typing is equally unlike a human. Pace both paths with
      // jittered per-character delays instead.
      await locator.click({ timeout, signal });
      throwIfInteractionAborted(opts.signal);
      await sleepWithAbort(humanClickSettleMs(), opts.signal);
      throwIfInteractionAborted(opts.signal);
      // Preserve `fill()` semantics (replace, not append) without using fill's
      // one-shot value set: clear via a real select-all + delete keystroke.
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
        throwIfInteractionAborted(opts.signal);
        await sleepWithAbort(humanSubmitPauseMs(), opts.signal);
        throwIfInteractionAborted(opts.signal);
        await locator.press("Enter", { timeout, signal });
      }
    },
    label,
  );
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
    const ref = field.ref.trim();
    if (!ref) {
      continue;
    }
    const type = (field.type || DEFAULT_FILL_FIELD_TYPE).trim() || DEFAULT_FILL_FIELD_TYPE;
    const rawValue = field.value;
    const value =
      typeof rawValue === "string"
        ? rawValue
        : typeof rawValue === "number" || typeof rawValue === "boolean"
          ? String(rawValue)
          : "";
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
  const fnText = normalizeOptionalString(opts.fn) ?? "";
  if (!fnText) {
    throw new Error("function is required");
  }
  const fnSource = normalizeBrowserEvaluateFunctionSource(
    fnText,
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
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal, (reason) => {
    if (isBrowserObservedDialogBlockedError(reason)) {
      return;
    }
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      reason: "evaluate aborted",
    }).catch(() => {});
  });
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  try {
    const navigationPolicy = interactionNavigationPolicy(opts);
    const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, signal);

    if (opts.ref) {
      const locator = refLocator(page, opts.ref);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
      const elementEvaluator = new Function(
        "el",
        "args",
        `
        "use strict";
        var fnSource = args.fnSource, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnSource + ")");
          if (typeof candidate !== "function") {
            throw new Error("evaluate source did not produce a function");
          }
          var result = candidate(el);
          if (result && typeof result.then === "function") {
            return Promise.race([
              result,
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
              })
            ]);
          }
          return result;
        } catch (err) {
          throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
        `,
      ) as (el: Element, args: { fnSource: string; timeoutMs: number }) => unknown;
      return await awaitNavigationGuardedInteraction(
        {
          action: async () =>
            await locator.evaluate(elementEvaluator, {
              fnSource,
              timeoutMs: evaluateTimeout,
            }),
          cdpUrl: opts.cdpUrl,
          page,
          ...navigationPolicy,
          targetId: opts.targetId,
        },
        abortPromise,
        signal,
        reconcileRemoteDialog,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
    const browserEvaluator = new Function(
      "args",
      `
        "use strict";
        var fnSource = args.fnSource, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnSource + ")");
          if (typeof candidate !== "function") {
            throw new Error("evaluate source did not produce a function");
          }
          var result = candidate();
          if (result && typeof result.then === "function") {
            return Promise.race([
              result,
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
              })
            ]);
          }
          return result;
        } catch (err) {
          throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
      `,
    ) as (args: { fnSource: string; timeoutMs: number }) => unknown;
    return await awaitNavigationGuardedInteraction(
      {
        action: async () =>
          await page.evaluate(browserEvaluator, {
            fnSource,
            timeoutMs: evaluateTimeout,
          }),
        cdpUrl: opts.cdpUrl,
        page,
        ...navigationPolicy,
        targetId: opts.targetId,
      },
      abortPromise,
      signal,
      reconcileRemoteDialog,
    );
  } finally {
    cleanup();
  }
}

export async function scrollIntoViewViaPlaywright(opts: ElementInteractionOptions): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);

  const { label, locator } = resolveInteractionElement(page, resolved);
  await runCancellablePageInteraction(
    page,
    opts,
    async (signal) => await locator.scrollIntoViewIfNeeded({ timeout, signal }),
    label,
  );
}
