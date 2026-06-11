import { useRoute, useLocation } from "wouter";
import { 
  useGetParlay, 
  useStartParlay, 
  useDeleteParlay,
  useCloseParlay,
  ParlayLegStatus 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetParlaysQueryKey, getGetParlayStatsQueryKey, getGetParlayQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Play, Trash2, ShieldAlert, XCircle, AlertTriangle } from "lucide-react";

export default function ParlayDetail() {
  const [, params] = useRoute("/parlays/:id");
  const id = params?.id ? parseInt(params.id) : 0;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: parlay, isLoading } = useGetParlay(id, {
    query: { queryKey: getGetParlayQueryKey(id), enabled: !!id, refetchInterval: (q) => {
      const status = (q.state.data as any)?.status;
      return status === "active" ? 10000 : false;
    }}
  });
  
  const startParlay = useStartParlay();
  const deleteParlay = useDeleteParlay();
  const closeParlay = useCloseParlay();

  const handleStart = () => {
    startParlay.mutate({ parlayId: id }, {
      onSuccess: (data) => {
        toast({ title: "串关已启动", description: "首场比赛投注已下达，仓位已激活。" });
        queryClient.invalidateQueries({ queryKey: getGetParlayQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getGetParlaysQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetParlayStatsQueryKey() });
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error || err?.message || "下单失败，请检查凭证和余额";
        toast({ title: "启动失败 — 下单未成功", description: msg, variant: "destructive" });
        queryClient.invalidateQueries({ queryKey: getGetParlayQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getGetParlaysQueryKey() });
      }
    });
  };

  const handleDelete = () => {
    if (confirm("确定要删除这个草稿吗？")) {
      deleteParlay.mutate({ parlayId: id }, {
        onSuccess: () => {
          toast({ title: "已删除" });
          queryClient.invalidateQueries({ queryKey: getGetParlaysQueryKey() });
          setLocation("/parlays");
        },
        onError: (err: any) => {
          toast({ title: "删除失败", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  const handleClose = () => {
    if (confirm("确定要手动关闭这个串关吗？该操作不会撤销已提交的链上订单。")) {
      closeParlay.mutate({ parlayId: id }, {
        onSuccess: () => {
          toast({ title: "串关已关闭", description: "已标记为已取消。" });
          queryClient.invalidateQueries({ queryKey: getGetParlayQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getGetParlaysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetParlayStatsQueryKey() });
        },
        onError: (err: any) => {
          toast({ title: "关闭失败", description: err.message, variant: "destructive" });
        }
      });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft": return <Badge variant="secondary" className="text-base py-1">草稿</Badge>;
      case "active": return <Badge variant="default" className="bg-accent text-accent-foreground text-base py-1">进行中</Badge>;
      case "won": return <Badge variant="default" className="bg-primary text-primary-foreground text-base py-1">胜利</Badge>;
      case "lost": return <Badge variant="destructive" className="text-base py-1">失败</Badge>;
      case "error": return <Badge variant="destructive" className="text-base py-1 bg-orange-600">下单出错</Badge>;
      case "cancelled": return <Badge variant="secondary" className="text-base py-1 opacity-60">已关闭</Badge>;
      default: return null;
    }
  };

  const getLegStatusInfo = (status: string) => {
    switch (status) {
      case "pending": return { text: "等待中", color: "text-muted-foreground" };
      case "active": return { text: "进行中", color: "text-accent" };
      case "won": return { text: "胜利", color: "text-primary" };
      case "lost": return { text: "失败", color: "text-destructive" };
      default: return { text: status, color: "" };
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <Skeleton className="h-10 w-32" />
        <Card className="h-64"></Card>
        <Card className="h-96"></Card>
      </div>
    );
  }

  if (!parlay) {
    return <div>未找到串关</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <Button variant="ghost" onClick={() => setLocation("/parlays")} className="mb-2 -ml-4">
        <ArrowLeft className="mr-2 w-4 h-4" /> 返回列表
      </Button>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-black font-serif tracking-tight flex items-center gap-3">
            {parlay.name}
            {getStatusBadge(parlay.status)}
          </h1>
          <div className="text-muted-foreground mt-2 flex items-center gap-2">
            创建于 {new Date(parlay.createdAt).toLocaleString()}
            {parlay.simulationMode && (
              <Badge variant="outline" className="bg-secondary/50 border-primary/20 text-xs py-0">模拟模式</Badge>
            )}
          </div>
        </div>
        
        <div className="flex gap-2 flex-wrap">
          {parlay.status === "draft" && (
            <>
              <Button variant="outline" className="text-destructive hover:bg-destructive/10" onClick={handleDelete} disabled={deleteParlay.isPending}>
                <Trash2 className="w-4 h-4 mr-2" /> 删除草稿
              </Button>
              <Button size="lg" className="font-bold" onClick={handleStart} disabled={startParlay.isPending}>
                {startParlay.isPending ? "下单中…" : "启动串关"}
                {!startParlay.isPending && <Play className="ml-2 w-4 h-4 fill-current" />}
              </Button>
            </>
          )}
          {(parlay.status === "error" || parlay.status === "active") && (
            <Button variant="outline" className="text-destructive hover:bg-destructive/10" onClick={handleClose} disabled={closeParlay.isPending}>
              <XCircle className="w-4 h-4 mr-2" /> {closeParlay.isPending ? "关闭中…" : "手动关闭"}
            </Button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {parlay.status === "error" && (
        <div className="p-4 rounded-xl border border-orange-500/40 bg-orange-500/10 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold text-orange-400">下单失败</p>
            <p className="text-sm text-muted-foreground mt-1">
              向 Polymarket 提交订单时出错。请检查你的 API 凭证、钱包余额和签名配置，然后手动关闭此串关并重新创建。
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground mb-2">初始金额</div>
            <div className="text-3xl font-black">${parlay.initialAmount.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card className="border-border/50 bg-card/50">
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground mb-2 flex justify-between">
              <span>当前金额</span>
              <span className="text-accent text-xs font-bold">进度 {parlay.currentLegIndex}/{parlay.totalLegs}</span>
            </div>
            <div className="text-3xl font-black">${parlay.currentAmount.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card className="border-border/50 bg-primary/10 border-primary/20">
          <CardContent className="p-6">
            <div className="text-sm text-muted-foreground mb-2 flex justify-between">
              <span>潜在最终收益</span>
              <span className="text-primary font-bold text-xs">1赔{parlay.totalOdds.toFixed(2)}</span>
            </div>
            <div className="text-3xl font-black text-accent">${parlay.potentialPayout.toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>

      <h2 className="text-2xl font-bold mt-8 mb-4">投注路线图</h2>
      
      <div className="space-y-4 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent">
        {parlay.legs.map((leg, index) => {
          const isPast = leg.status === "won" || leg.status === "lost";
          const isActive = leg.status === "active";
          const isFuture = leg.status === "pending";
          const { text: statusText, color: statusColor } = getLegStatusInfo(leg.status);
          
          return (
            <div key={leg.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
              {/* Timeline dot */}
              <div className={`flex items-center justify-center w-10 h-10 rounded-full border-4 border-background shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow absolute left-0 md:left-1/2 -translate-x-0 z-10 
                ${isPast ? (leg.status === 'won' ? 'bg-primary' : 'bg-destructive') : isActive ? 'bg-accent animate-pulse' : 'bg-muted'}
              `}>
                <span className="text-xs font-bold text-background">{index + 1}</span>
              </div>
              
              {/* Card */}
              <Card className={`w-[calc(100%-3rem)] md:w-[calc(50%-2.5rem)] ml-12 md:ml-0 border-border/50 transition-colors
                ${isActive ? 'border-accent shadow-md shadow-accent/10' : ''}
                ${leg.status === 'lost' ? 'opacity-70 grayscale-[0.5]' : ''}
              `}>
                <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between">
                  <span className={`font-bold text-sm px-2 py-0.5 rounded ${statusColor} bg-muted`}>
                    {statusText}
                  </span>
                  <div className="text-sm font-bold text-primary">
                    1赔{Math.max(...leg.selectedOutcomes.map(o => o.odds)).toFixed(2)}
                  </div>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <h3 className="font-bold text-lg mb-3 leading-tight">{leg.marketTitle}</h3>
                  
                  <div className="space-y-2 mb-4">
                    {leg.selectedOutcomes.map(o => (
                      <div key={o.name} className="flex justify-between items-center text-sm p-2 rounded bg-muted/50 border border-border/30">
                        <span>{o.name}</span>
                        <span className="font-mono font-medium">1赔{o.odds.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-between items-end border-t border-border/30 pt-3 mt-3">
                    <div>
                      <div className="text-xs text-muted-foreground">投注金额</div>
                      <div className="font-bold">
                        {leg.stakeAmount != null ? `$${leg.stakeAmount.toFixed(2)}` : "-"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">返还金额</div>
                      <div className={`font-bold ${leg.status === 'won' ? 'text-accent' : leg.status === 'lost' ? 'text-destructive' : ''}`}>
                        {leg.payoutAmount !== null && leg.payoutAmount !== undefined ? `$${leg.payoutAmount.toFixed(2)}` : "-"}
                      </div>
                    </div>
                  </div>

                  {leg.polymarketOrderId && (
                    <div className="mt-2 text-xs text-muted-foreground font-mono truncate" title={leg.polymarketOrderId}>
                      订单: {leg.polymarketOrderId.slice(0, 16)}…
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          );
        })}
      </div>
      
      {parlay.status === "lost" && (
        <div className="mt-12 p-6 rounded-xl border border-destructive/30 bg-destructive/10 text-center">
          <ShieldAlert className="w-12 h-12 text-destructive mx-auto mb-4" />
          <h3 className="text-xl font-bold text-destructive mb-2">战役失败</h3>
          <p className="text-muted-foreground">串关在第 {parlay.currentLegIndex} 场比赛终止。不要气馁，下一次会更好。</p>
        </div>
      )}
    </div>
  );
}
