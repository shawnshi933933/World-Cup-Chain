import { useState } from "react";
import { useLocation } from "wouter";
import { Wallet, ShieldCheck, Key, CheckCircle2, Loader2, AlertCircle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

type Step = "connect" | "sign" | "save" | "done";

interface Creds {
  apiKey: string;
  secret: string;
  passphrase: string;
  walletAddress: string;
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(method: string, path: string, body: object) {
  const token = localStorage.getItem("app_token") ?? "";
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data;
}
const apiPost = (path: string, body: object) => apiFetch("POST", path, body);
const apiPut  = (path: string, body: object) => apiFetch("PUT",  path, body);

export default function WalletSetupPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("connect");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [creds, setCreds] = useState<Creds | null>(null);

  const clearError = () => setError(null);

  async function connectWallet() {
    clearError();
    if (!window.ethereum) {
      setError("未检测到 MetaMask，请先安装 MetaMask 浏览器插件。");
      return;
    }
    setLoading(true);
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
      if (!accounts || accounts.length === 0) throw new Error("未选择账户");
      setWalletAddress(accounts[0]);
      setStep("sign");
    } catch (e: unknown) {
      setError((e as Error).message ?? "连接钱包失败");
    } finally {
      setLoading(false);
    }
  }

  async function signAndDerive() {
    if (!walletAddress) return;
    clearError();
    setLoading(true);
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = await window.ethereum!.request({
        method: "personal_sign",
        params: [timestamp, walletAddress],
      }) as string;

      const data = await apiPost("/api/auth/derive-key", { walletAddress, signature, timestamp }) as Creds;
      setCreds(data);
      setStep("save");
    } catch (e: unknown) {
      setError((e as Error).message ?? "签名或派生失败");
    } finally {
      setLoading(false);
    }
  }

  async function saveCredentials() {
    if (!creds) return;
    clearError();
    setLoading(true);
    try {
      await apiPost("/api/auth/save-key", creds);
      await apiPut("/api/settings", { simulationMode: false, walletAddress: creds.walletAddress });
      setStep("done");
      toast({ title: "✅ 凭证已保存，已切换到真实投注模式" });
    } catch (e: unknown) {
      setError((e as Error).message ?? "保存失败");
    } finally {
      setLoading(false);
    }
  }

  const steps = [
    { id: "connect", label: "连接钱包" },
    { id: "sign",    label: "Polymarket 授权" },
    { id: "save",    label: "保存凭证" },
    { id: "done",    label: "完成" },
  ] as const;

  const stepIndex = steps.findIndex(s => s.id === step);

  return (
    <div className="max-w-lg mx-auto py-10 px-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Polymarket 钱包授权</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          连接你的 MetaMask，签名一次即可自动获取 Polymarket API 凭证，无需手动复制任何私钥。
        </p>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-1">
        {steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-1">
            <div className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full transition-colors ${
              i < stepIndex
                ? "bg-green-500/20 text-green-400"
                : i === stepIndex
                  ? "bg-yellow-400/20 text-yellow-400"
                  : "bg-muted text-muted-foreground"
            }`}>
              {i < stepIndex
                ? <CheckCircle2 className="w-3 h-3" />
                : <span className="w-3 h-3 flex items-center justify-center text-[10px] font-bold">{i + 1}</span>
              }
              {s.label}
            </div>
            {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Step: Connect */}
      {step === "connect" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-yellow-400" />
              第一步：连接 MetaMask
            </CardTitle>
            <CardDescription>
              点击后浏览器会弹出 MetaMask 授权窗口，选择你用于 Polymarket 投注的钱包账户。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={connectWallet} disabled={loading} className="w-full bg-yellow-400 hover:bg-yellow-500 text-black font-bold">
              {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />连接中...</> : <><Wallet className="w-4 h-4 mr-2" />连接 MetaMask</>}
            </Button>
            <p className="text-xs text-muted-foreground mt-3 text-center">
              没有 MetaMask？先去 <a href="https://metamask.io" target="_blank" rel="noreferrer" className="underline">metamask.io</a> 安装插件
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step: Sign */}
      {step === "sign" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="w-5 h-5 text-yellow-400" />
              第二步：授权 Polymarket
            </CardTitle>
            <CardDescription>
              已连接：<span className="font-mono text-foreground">{walletAddress}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg bg-muted/50 border p-3 text-sm text-muted-foreground space-y-1">
              <p>点击下方按钮后，MetaMask 会弹出一个<strong className="text-foreground">签名请求</strong>（不是转账，不花 Gas）。</p>
              <p>签名会发送给 Polymarket 服务器，Polymarket 为你的钱包生成 API 密钥，返回后自动保存。</p>
            </div>
            <Button onClick={signAndDerive} disabled={loading} className="w-full bg-yellow-400 hover:bg-yellow-500 text-black font-bold">
              {loading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />正在与 Polymarket 通信...</>
                : <><ShieldCheck className="w-4 h-4 mr-2" />签名并获取 API 凭证</>
              }
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step: Save */}
      {step === "save" && creds && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-green-400" />
              第三步：确认保存
            </CardTitle>
            <CardDescription>凭证已从 Polymarket 获取，确认后保存到应用并开启真实投注模式。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg bg-muted/50 border p-3 font-mono text-xs space-y-1.5 break-all">
              <div><span className="text-muted-foreground">钱包：</span><span className="text-foreground">{creds.walletAddress}</span></div>
              <div><span className="text-muted-foreground">API Key：</span><span className="text-foreground">{creds.apiKey.slice(0, 8)}••••{creds.apiKey.slice(-4)}</span></div>
              <div><span className="text-muted-foreground">Secret：</span><span className="text-foreground">••••••••</span></div>
              <div><span className="text-muted-foreground">Passphrase：</span><span className="text-foreground">••••••••</span></div>
            </div>
            <Button onClick={saveCredentials} disabled={loading} className="w-full bg-yellow-400 hover:bg-yellow-500 text-black font-bold">
              {loading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />保存中...</>
                : <><CheckCircle2 className="w-4 h-4 mr-2" />保存凭证 + 开启真实投注</>
              }
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step: Done */}
      {step === "done" && (
        <Card className="border-green-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-400">
              <CheckCircle2 className="w-5 h-5" />
              授权完成！
            </CardTitle>
            <CardDescription>
              Polymarket API 凭证已保存，模拟模式已关闭。现在可以用真实 USDC 下注了。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg bg-yellow-400/10 border border-yellow-400/30 p-3 text-sm text-yellow-300">
              ⚠️ 请确保你的 Polygon 钱包里有足够的 <strong>USDC</strong>，并已在 Polymarket 完成账户注册。
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => navigate("/markets")}>
                去选市场
              </Button>
              <Button className="flex-1 bg-yellow-400 hover:bg-yellow-500 text-black font-bold" onClick={() => navigate("/parlays/new")}>
                开始串关
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
