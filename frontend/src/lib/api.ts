const TOKEN_KEY = "auction_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.error ?? message;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body?: unknown) => request<T>("POST", path, body),
};

export function wsURL(itemID: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = getToken() ?? "";
  return `${proto}//${window.location.host}/ws/auctions/${itemID}?token=${encodeURIComponent(token)}`;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // api-server's imagestore.MaxBytes
export const MAX_IMAGES = 10; // api-server's maxImages

// Uploads one photo and returns the URL to put in an item's image_urls.
// No Content-Type header: the browser sets the multipart boundary itself.
export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch("/api/uploads/images", { method: "POST", headers, body: form });
  if (!res.ok) {
    let message = res.status === 413 ? "ไฟล์ใหญ่เกิน 8 MB" : res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      // nginx's own 413 page isn't JSON
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()).url as string;
}
