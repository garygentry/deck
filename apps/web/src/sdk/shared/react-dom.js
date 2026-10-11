// The host's own `react-dom`, re-exported for runtime modules through the page's import map,
// so a module renders with the one React the shell runs. Plain JS, since the list includes
// names the type packages do not declare; test/sdk.test.ts pins it to the package's exports.
import ReactDOM from "react-dom";
export {
  __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  browser,
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
  unstable_batchedUpdates,
  useFormState,
  useFormStatus,
  version,
} from "react-dom";
export default ReactDOM;
