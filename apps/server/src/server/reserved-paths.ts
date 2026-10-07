/**
 * Root paths outside /api the kernel may serve, which no module may claim. None today: every
 * root path deck serves is a module's declared `contributes.routes.rootPaths`.
 */
export const RESERVED_ROOT_PATHS: readonly string[] = [];
