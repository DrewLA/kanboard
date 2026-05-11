export class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.message || "Request failed.");
    this.name = "ApiError";
    this.status = status;
    this.code = payload?.code;
    this.recovery = payload?.recovery;
    this.payload = payload;
  }
}

export async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: "Request failed." }));
    throw new ApiError(payload, response.status);
  }

  return response.json();
}

export function getErrorMessage(error) {
  if (error instanceof ApiError && error.recovery) {
    return `${error.message} ${error.recovery}`;
  }

  return error instanceof Error ? error.message : "Request failed.";
}
