import { useState, useEffect, type ReactNode } from "react";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { Lock, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const TOKEN_KEY = "app_token";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

async function checkToken(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const r = await fetch(`${BASE}/api/auth/check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function doLogin(password: string): Promise<{ open: boolean; token: string | null; error?: string }> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await r.json() as { open?: boolean; token?: string | null; error?: string };
  if (!r.ok) return { open: false, token: null, error: data.error ?? "密码错误" };
  return { open: !!data.open, token: data.token ?? null };
}

type Status = "loading" | "locked" | "unlocked";

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [password, setPassword] = useState("");
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState(false);

  useEffect(() => {
    setAuthTokenGetter(getStoredToken);

    const stored = getStoredToken();

    checkToken(stored).then(valid => {
      if (valid) { setStatus("unlocked"); return; }

      doLogin("").then(({ open }) => {
        if (open) {
          setStatus("unlocked");
        } else {
          localStorage.removeItem(TOKEN_KEY);
          setAuthTokenGetter(() => "");
          setStatus("locked");
        }
      }).catch(() => setStatus("locked"));
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { open, token, error: err } = await doLogin(password);
      if (err) { setError(err); return; }
      const tok = open ? "" : (token ?? "");
      localStorage.setItem(TOKEN_KEY, tok);
      setAuthTokenGetter(() => tok);
      setStatus("unlocked");
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-yellow-400" />
      </div>
    );
  }

  if (status === "locked") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-yellow-400/10 border border-yellow-400/30 mb-2">
              <Lock className="w-7 h-7 text-yellow-400" />
            </div>
            <h1 className="text-2xl font-black tracking-tight">炜新联手征战世界杯</h1>
            <p className="text-muted-foreground text-sm">请输入访问密码继续</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <Input
              type="password"
              placeholder="访问密码"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="text-center font-mono text-lg h-12 bg-muted/50"
              autoFocus
              disabled={busy}
            />
            {error && (
              <p className="text-red-400 text-sm text-center">{error}</p>
            )}
            <Button
              type="submit"
              disabled={busy || !password}
              className="w-full h-12 bg-yellow-400 hover:bg-yellow-500 text-black font-bold text-base"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <><ShieldCheck className="w-5 h-5 mr-2" />进入</>}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
