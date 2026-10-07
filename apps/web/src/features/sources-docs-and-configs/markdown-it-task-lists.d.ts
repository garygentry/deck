/**
 * Ambient declaration for `markdown-it-task-lists` — the package ships no types and has no
 * `@types/` counterpart. It is a standard markdown-it plugin: a function applied via
 * `md.use(taskLists, options?)` that adds GFM task-list checkboxes.
 */
declare module "markdown-it-task-lists" {
  import type { PluginWithOptions } from "markdown-it";

  interface TaskListsOptions {
    /** Enable the interactive checkbox (deck renders read-only, so this stays false). */
    readonly enabled?: boolean;
    /** Wrap the item text in a <label> associated with the checkbox. */
    readonly label?: boolean;
    /** Place the <label> after the checkbox rather than around the whole item. */
    readonly labelAfter?: boolean;
  }

  const taskLists: PluginWithOptions<TaskListsOptions>;
  export default taskLists;
}
