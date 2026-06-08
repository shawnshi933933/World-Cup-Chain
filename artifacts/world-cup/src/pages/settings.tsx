import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useGetSettings, useUpdateSettings } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Shield, Key, Wallet, Save, Activity } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

const settingsSchema = z.object({
  simulationMode: z.boolean().default(true),
  polymarketApiKey: z.string().optional(),
  walletAddress: z.string().optional()
});

type SettingsFormValues = z.infer<typeof settingsSchema>;

export default function SettingsPage() {
  const { toast } = useToast();
  const { data: settings, isLoading } = useGetSettings();
  const updateSettings = useUpdateSettings();

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      simulationMode: true,
      polymarketApiKey: "",
      walletAddress: ""
    }
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        simulationMode: settings.simulationMode,
        polymarketApiKey: settings.hasApiKey ? "********" + (settings.polymarketApiKey || "") : "",
        walletAddress: settings.walletAddress || ""
      });
    }
  }, [settings, form]);

  const onSubmit = (data: SettingsFormValues) => {
    // Don't send masked API key back to server
    const payload = { ...data };
    if (payload.polymarketApiKey?.startsWith("********")) {
      delete payload.polymarketApiKey;
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
              <CardTitle className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-primary" />
                Polymarket 凭证
              </CardTitle>
              <CardDescription>
                仅在关闭模拟模式时需要。您的 API 密钥将被加密存储。
              </CardDescription>
            </CardHeader>
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
                        placeholder="输入您的 Polymarket API 密钥" 
                        type="password" 
                        {...field} 
                        className="font-mono bg-background"
                      />
                    </FormControl>
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

        </form>
      </Form>
    </div>
  );
}