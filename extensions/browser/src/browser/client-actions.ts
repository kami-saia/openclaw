/**
 * Public browser action client barrel.
 *
 * Re-exports the action helpers used by Browser tool registration and tests.
 */
export {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserDownload,
  browserNavigate,
  browserScreenshotAction,
  browserWaitForDownload,
} from "./client-actions-core.js";
export {
  browserConsoleMessages,
  browserRequests,
  browserErrors,
  browserPageText,
  // FORK: structured /extract endpoint used by `browser action=extract`.
  browserPageContent,
  browserEmulateSetting,
  browserPdfSave,
} from "./client-actions-observe.js";
