import OpenAI from "openai";

/** Known OpenAI API error codes (see https://platform.openai.com/docs/guides/error-codes) */
export type OpenAIErrorCode =
  | "insufficient_quota"
  | "rate_limit_exceeded"
  | "invalid_api_key"
  | "invalid_request_error"
  | "server_error"
  | string;

export interface HandledOpenAIError {
  isOpenAI: true;
  code: OpenAIErrorCode;
  status: number | undefined;
  type: string | undefined;
  message: string;
  /** User-friendly short label for this error */
  label: string;
}

/**
 * Type guard: returns true if the value is an OpenAI APIError.
 */
export function isOpenAIError(
  error: unknown,
): error is InstanceType<typeof OpenAI.APIError> {
  return error instanceof OpenAI.APIError;
}

/**
 * Get a short, user-friendly label for an OpenAI error code.
 */
function getLabelForCode(code: string | undefined): string {
  switch (code) {
    case "insufficient_quota":
      return "API quota exceeded – check billing and usage limits.";
    case "rate_limit_exceeded":
      return "Rate limit reached – slow down or retry later.";
    case "invalid_api_key":
      return "Invalid or missing API key.";
    case "invalid_request_error":
      return "Invalid request – check parameters.";
    case "server_error":
      return "OpenAI server error – retry later.";
    default:
      return code ? `OpenAI API error (${code})` : "OpenAI API error";
  }
}

/**
 * Normalize an unknown error into a HandledOpenAIError if it's an OpenAI error,
 * or return null otherwise.
 */
export function normalizeOpenAIError(
  error: unknown,
): HandledOpenAIError | null {
  if (!isOpenAIError(error)) return null;
  const code = (error.code as OpenAIErrorCode) ?? "unknown";
  return {
    isOpenAI: true,
    code,
    status: error.status,
    type: error.type ?? undefined,
    message: error.message,
    label: getLabelForCode(error.code ?? undefined),
  };
}

export interface HandleOpenAIErrorOptions {
  /** Short context for logs (e.g. "converting entry files to layout") */
  context?: string;
  /** If true, rethrow after handling. Default true. */
  rethrow?: boolean;
  /** Custom log function. Default: console.error for message, console.log for label. */
}

/**
 * Reusable handler for OpenAI errors in catch blocks.
 * Logs appropriately by code, optionally runs onQuotaExceeded, then rethrows by default.
 *
 * @example
 * try {
 *   await openAIClient.responses.parse({ ... });
 * } catch (error) {
 *   handleOpenAIError(error, { context: "converting entry files to layout" });
 * }
 */
export function handleOpenAIError(
  error: unknown,
  options: HandleOpenAIErrorOptions = {},
) {
  const { context = "", rethrow = false } = options;

  const prefix = context ? `OpenAI Error: [${context}] ` : "";

  const openAI = normalizeOpenAIError(error);
  if (openAI) {
    if (openAI.code === "insufficient_quota") {
      console.error(prefix + "API quota exceeded. " + openAI.label);
    } else {
      console.error(prefix + openAI.label);
      console.error(
        prefix + "Code:",
        openAI.code,
        "Status:",
        openAI.status,
        "Type:",
        openAI.type,
      );
      console.error(prefix + "Message:", openAI.message);
    }
  } else {
    console.error(prefix + "Unexpected error:", error);
  }

  if (rethrow) throw error;
  //   throw new Error(
  //     "handleOpenAIError: rethrow is false but function must throw",
  //   );
}
