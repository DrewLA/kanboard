export async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: "Request failed." }));
    throw new Error(payload.message || "Request failed.");
  }

  return response.json();
}

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Request failed.";
}
