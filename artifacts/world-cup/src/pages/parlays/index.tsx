import { useState } from "react";
import { useGetParlays, GetParlaysStatus } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { PlusCircle, List, ArrowRight } from "lucide-react";

export default function ParlaysIndex() {
  const [status, setStatus] = useState<GetParlaysStatus>("all");
  const { data: parlays, isLoading } = useGetParlays({ status: status === "all" ? undefined : status });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft": return <Badge variant="secondary">草稿</Badge>;
      case "active": return <Badge variant="default" className="bg-accent text-accent-foreground">进行中</Badge>;
      case "won": return <Badge variant="default" className="bg-primary text-primary-foreground">胜利</Badge>;
      case "lost": return <Badge variant="destructive">失败</Badge>;
      case "error": return <Badge className="bg-orange-600 text-white">下单出错</Badge>;
      case "cancelled": return <Badge variant="secondary" className="opacity-60">已关闭</Badge>;
      default: return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black font-serif tracking-tight">我的串关</h1>
          <p className="text-muted-foreground mt-1">查看和管理您的所有串关</p>
        </div>
        
        <Button asChild>
          <Link href="/parlays/new">
            <PlusCircle className="mr-2 h-4 w-4" />
            新建串关
          </Link>
        </Button>
      </div>

      <Tabs value={status} onValueChange={(v) => setStatus(v as GetParlaysStatus)} className="w-full">
        <TabsList className="grid w-full grid-cols-4 lg:w-[400px]">
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="active">进行中</TabsTrigger>
          <TabsTrigger value="won">胜利</TabsTrigger>
          <TabsTrigger value="lost">失败</TabsTrigger>
        </TabsList>

        <div className="mt-6">
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map(i => (
                <Card key={i} className="animate-pulse bg-muted h-48 border-0"></Card>
              ))}
            </div>
          ) : parlays && parlays.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {parlays.map((parlay) => (
                <Card key={parlay.id} className={`border-border/50 bg-card/50 hover:border-primary/50 transition-colors group cursor-pointer flex flex-col
                  ${parlay.status === 'error' ? 'border-orange-500/40 bg-orange-500/5' : ''}
                  ${parlay.status === 'cancelled' ? 'opacity-60' : ''}
                `}>
                  <Link href={`/parlays/${parlay.id}`} className="flex-1 flex flex-col">
                    <CardHeader className="pb-2">
                      <div className="flex justify-between items-start mb-1 gap-2">
                        <CardTitle className="text-lg group-hover:text-primary transition-colors line-clamp-1">{parlay.name}</CardTitle>
                        {getStatusBadge(parlay.status)}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        进度: {parlay.currentLegIndex}/{parlay.totalLegs} • 赔率: 1赔{parlay.totalOdds.toFixed(2)}
                      </div>
                    </CardHeader>
                    <CardContent className="mt-auto">
                      <div className="flex justify-between items-end bg-background/50 p-3 rounded-lg border border-border/50">
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">初始/当前</div>
                          <div className="font-bold">
                            ${parlay.initialAmount.toFixed(2)} <ArrowRight className="inline w-3 h-3 text-muted-foreground mx-1" /> ${parlay.currentAmount.toFixed(2)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-muted-foreground mb-1">潜在收益</div>
                          <div className="font-bold text-accent">${parlay.potentialPayout.toFixed(2)}</div>
                        </div>
                      </div>
                      {parlay.status === 'error' && (
                        <p className="text-xs text-orange-400 mt-2">⚠️ 下单失败 — 点击查看详情并手动关闭</p>
                      )}
                    </CardContent>
                  </Link>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-20 bg-card/30 rounded-xl border border-dashed">
              <List className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-bold mb-2">无记录</h3>
              <p className="text-muted-foreground mb-6">您目前没有相关状态的串关记录。</p>
              {status !== "all" && (
                <Button variant="outline" onClick={() => setStatus("all")}>查看全部</Button>
              )}
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
