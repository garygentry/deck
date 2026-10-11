/** Deck's API error body: what every kernel and module route answers a refused request with. */
export interface ApiErrorBody {
  error: string;
  code?: string;
}

/** Build an {@link ApiErrorBody}; `code` is omitted when undefined, so the bytes match the kernel's. */
export function apiErrorBody(error: string, code?: string): ApiErrorBody {
  return { error, ...(code === undefined ? {} : { code }) };
}
