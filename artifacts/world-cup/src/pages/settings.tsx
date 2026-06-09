import { useEffect, useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetSettings, useUpdateSettings, getGetParlaysQueryKey, getGetParlayStatsQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Shield, Key, Wallet, Save, Activity, Lock, Trash2, FlaskConical, Terminal, Copy, CheckCheck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

const settingsSchema = z.object({
  simulationMode: z.boolean().default(true),
  polymarketApiKey: z.string().optional(),
  polymarketSecret: z.string().optional(),
  polymarketPassphrase: z.string().optional(),
  walletAddress: z.string().optional()
});

type SettingsFormValues = z.infer<typeof settingsSchema>;

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const GET_KEY_SCRIPT = `pip install py-clob-client
python3 - <<'PY'
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds

# 替换成你的私钥（Polygon 钱包）
PRIVATE_KEY = "0x你的私钥"
CHAIN_ID    = 137   # Polygon mainnet

client = ClobClient("https://clob.polymarket.com", key=PRIVATE_KEY, chain_id=CHAIN_ID)
creds  = client.create_or_derive_api_creds()

print("apiKey     :", creds.api_key)
print("secret     :", creds.api_secret)
print("passphrase :", creds.api_passphrase)
PY`;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button
      onClick={copy}
      className="absolute top-2 right-2 p-1.5 rounded bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
      title="复制"
    >
      {copied ? <CheckCheck className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const { data: settings, isLoading } = useGetSettings();
  const updateSettings = useUpdateSettings();

  async function clearSimulationData() {
    setDeleting(true);
    try {
      const token = localStorage.getItem("app_token") ?? "";
      const r = await fetch(`${BASE}/api/parlays/simulation`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await r.json() as { deleted?: number; error?: string };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      queryClient.invalidateQueries({ queryKey: getGetParlaysQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetParlayStatsQueryKey() });
      toast({ title: `已清除 ${data.deleted ?? 0} 条模拟串关记录` });
    } catch (e: unknown) {
      toast({ title: "清除失败", description: (e as Error).message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      simulationMode: true,
      polymarketApiKey: "",
      polymarketSecret: "",
      polymarketPassphrase: "",
      walletAddress: ""
    }
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        simulationMode: settings.simulationMode,
        polymarketApiKey: settings.hasApiKey ? "••••••••" : "",
        polymarketSecret: settings.hasSecret ? "••••••••" : "",
        polymarketPassphrase: settings.hasPassphrase ? "••••••••" : "",
        walletAddress: settings.walletAddress || ""
      });
    }
  }, [settings, form]);

  const onSubmit = (data: SettingsFormValues) => {
    const payload: SettingsFormValues = { simulationMode: data.simulationMode, walletAddress: data.walletAddress };
    if (data.polymarketApiKey && !data.polymarketApiKey.startsWith("••••")) {
      payload.polymarketApiKey = data.polymarketApiKey;
    }
    if (data.polymarketSecret && !data.polymarketSecret.startsWith("••••")) {
      payload.polymarketSecret = data.polymarketSecret;
    }
    if (data.polymarketPassphrase && !data.polymarketPassphrase.startsWith("••••")) {
      payload.polymarketPassphrase = data.polymarketPassphrase;
    }

    updateSettings.mutate({ data: payload }, {
      onSuccess: () => {
        toast({ title: "设置已保存", description: "您的首选项已更新。" });
      },
      onError: (err: any) => {
        toast({ title: "保存失败", description: err.message, variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 mb-8" />
        <Card className="h-[400px]"></Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-black font-serif tracking-tight">系统设置</h1>
        <p className="text-muted-foreground mt-1">配置您的 Polymarket 账户和应用偏好</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

          <Card className="border-border/50 bg-card/50 overflow-hidden">
            <div className={`h-2 ${form.watch('simulationMode') ? 'bg-primary' : 'bg-destructive'}`}></div>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                运行模式
              </CardTitle>
              <CardDescription>
                控制应用是使用真实资金还是模拟数据。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="simulationMode"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-4 bg-background">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base font-bold">模拟模式</FormLabel>
                      <FormDescription>
                        {field.value
                          ? "当前: 安全。不会扣除真实资金，所有操作均为模拟。"
                          : "当前: 危险！关闭此选项将使用真实 USDC 在 Polymarket 下单。"}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className={field.value ? "data-[state=checked]:bg-primary" : "data-[state=unchecked]:bg-destructive"}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/50">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Shield className="w-5 h-5 text-primary" />
                    Polymarket L2 凭证
                  </CardTitle>
                  <CardDescription className="mt-1.5">
                    仅在关闭模拟模式时需要。在下方直接粘贴凭证，或点击"如何获取"查看步骤。
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 border border-dashed border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground/40"
                  onClick={() => setShowGuide(v => !v)}
                >
                  <Terminal className="w-4 h-4 mr-1.5" />
                  {showGuide ? "收起" : "如何获取"}
                </Button>
              </div>
            </CardHeader>

            {showGuide && (
              <div className="mx-6 mb-4 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-4 space-y-3 text-sm">
                <p className="font-semibold text-yellow-300 flex items-center gap-1.5">
                  <Terminal className="w-4 h-4" /> 用本地终端获取 Polymarket API 凭证
                </p>
                <ol className="space-y-2 text-muted-foreground list-decimal list-inside">
                  <li>开启 VPN（连接美国节点）</li>
                  <li>确保已安装 Python 3，打开终端运行下面的脚本</li>
                  <li>把输出的 <code className="text-foreground bg-muted px-1 rounded text-xs">apiKey / secret / passphrase</code> 粘贴到下方输入框</li>
                </ol>
                <div className="relative">
                  <pre className="rounded bg-muted p-3 text-xs font-mono overflow-x-auto pr-10 text-foreground/80 whitespace-pre-wrap">{GET_KEY_SCRIPT}</pre>
                  <CopyButton text={GET_KEY_SCRIPT} />
                </div>
                <p className="text-xs text-muted-foreground">
                  ⚠️ 私钥只在你本地运行，不会传到任何服务器。脚本用完即丢。
                </p>
              </div>
            )}

            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="polymarketApiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Key className="w-4 h-4 text-muted-foreground" />
                      API Key
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="输入您的 Polymarket API Key"
                        type="password"
                        autoComplete="off"
                        {...field}
                        className="font-mono bg-background"
                      />
                    </FormControl>
                    {settings?.hasApiKey && (
                      <FormDescription className="text-green-500">✓ 已配置</FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="polymarketSecret"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Lock className="w-4 h-4 text-muted-foreground" />
                      API Secret
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="输入您的 Polymarket API Secret"
                        type="password"
                        autoComplete="off"
                        {...field}
                        className="font-mono bg-background"
                      />
                    </FormControl>
                    {settings?.hasSecret && (
                      <FormDescription className="text-green-500">✓ 已配置</FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="polymarketPassphrase"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Lock className="w-4 h-4 text-muted-foreground" />
                      API Passphrase
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="输入您的 Polymarket API Passphrase"
                        type="password"
                        autoComplete="off"
                        {...field}
                        className="font-mono bg-background"
                      />
                    </FormControl>
                    {settings?.hasPassphrase && (
                      <FormDescription className="text-green-500">✓ 已配置</FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="walletAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Wallet className="w-4 h-4 text-muted-foreground" />
                      钱包地址
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="0x..."
                        autoComplete="off"
                        {...field}
                        className="font-mono bg-background"
                      />
                    </FormControl>
                    <FormDescription>
                      用于接收派发的奖金。
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
            <CardFooter className="bg-muted/50 border-t border-border/50 px-6 py-4">
              <Button type="submit" disabled={updateSettings.isPending} className="w-full md:w-auto font-bold">
                {updateSettings.isPending ? "保存中..." : "保存设置"}
                {!updateSettings.isPending && <Save className="ml-2 w-4 h-4" />}
              </Button>
            </CardFooter>
          </Card>

          <Card className="border-red-500/30 bg-card/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-400">
                <FlaskConical className="w-5 h-5" />
                数据管理
              </CardTitle>
              <CardDescription>
                切换到真实投注模式前，建议先清除所有模拟记录，避免与真实数据混淆。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                <div>
                  <p className="font-medium text-sm">清空模拟串关记录</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    删除所有 <span className="text-yellow-400 font-mono">simulation_mode = true</span> 的串关及其投注腿，不影响真实数据。
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={deleting}
                      className="shrink-0 ml-4 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 className="w-4 h-4 mr-1.5" />
                      {deleting ? "清除中..." : "清除模拟数据"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>确认清除模拟数据？</AlertDialogTitle>
                      <AlertDialogDescription>
                        此操作将永久删除所有模拟串关记录（包括进行中和已结算的），无法恢复。真实模式下的串关不受影响。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={clearSimulationData}
                        className="bg-red-500 hover:bg-red-600 text-white"
                      >
                        确认清除
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>

        </form>
      </Form>
    </div>
  );
}
