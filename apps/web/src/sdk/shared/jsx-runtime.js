// The host's own `react/jsx-runtime`, re-exported for runtime modules through the page's import map,
// so a module renders with the one React the shell runs. Plain JS, since the list includes
// names the type packages do not declare; test/sdk.test.ts pins it to the package's exports.
export {
  Fragment,
  jsx,
  jsxs,
} from "react/jsx-runtime";
